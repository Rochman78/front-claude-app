import { NextRequest, NextResponse } from 'next/server';
import { callClaude } from '@/lib/services/claudeService';
import pool, { initDB } from '@/lib/db';

/** Taux de TVA disponibles dans prix-ht-standards.txt (colonnes 4 à 15 des lignes) */
const VAT_RATES = [0, 17, 18, 19, 20, 21, 22, 23, 24, 25, 25.5, 27];

/** Retourne l'index de colonne HT correspondant à un taux TVA, ou -1 si inconnu */
function vatColumnIndex(vatPercent: number): number {
  // Tolérance 0.05 pour cover 25.5
  return VAT_RATES.findIndex((r) => Math.abs(r - vatPercent) < 0.05);
}

/** Parse une ligne du fichier prix-ht-standards.txt (nouveau format tabulaire).
 *  Colonnes : typologie | forme | matiere | couleur | taille | SKU | TTC | HT × 12
 *  Retourne un dict par SKU. */
function parsePriceFile(content: string): Record<string, { ttc: number; hts: number[]; label: string }> {
  const out: Record<string, { ttc: number; hts: number[]; label: string }> = {};
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('═') || line.startsWith('-') || line.startsWith('⚠') || line.startsWith('ℹ')) continue;
    const parts = line.split('|').map((p) => p.trim());
    // Attend 19 colonnes (6 meta + 1 TTC + 12 HT)
    if (parts.length !== 19) continue;
    const sku = parts[5];
    if (!/^\d{12,14}$/.test(sku)) continue;
    const ttc = parseFloat(parts[6].replace(',', '.'));
    if (Number.isNaN(ttc)) continue;
    const hts: number[] = [];
    for (let i = 7; i < 19; i++) {
      const v = parseFloat(parts[i].replace(',', '.'));
      if (Number.isNaN(v)) break;
      hts.push(v);
    }
    if (hts.length !== 12) continue;
    const label = `${parts[0]} ${parts[1]} ${parts[2]} ${parts[3]} ${parts[4]}`.trim();
    out[sku] = { ttc, hts, label };
  }
  return out;
}

/** Charge le prix-ht-standards.txt d'un store depuis la BDD.
 *  Cache mémoire simple (invalidé au restart process). */
const priceFileCache: Record<string, { at: number; catalog: Record<string, { ttc: number; hts: number[]; label: string }> }> = {};
async function loadPriceCatalog(storeCode: string): Promise<Record<string, { ttc: number; hts: number[]; label: string }>> {
  const cached = priceFileCache[storeCode];
  // Cache 5 min pour éviter de recharger sur chaque devis
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.catalog;
  await initDB();
  const { rows } = await pool.query(
    `SELECT af.content FROM agent_files af
     JOIN agents a ON a.id = af.agent_id
     WHERE a.store_code = $1 AND af.name = 'prix-ht-standards.txt'
     LIMIT 1`,
    [storeCode]
  );
  if (rows.length === 0) return {};
  const catalog = parsePriceFile(rows[0].content);
  priceFileCache[storeCode] = { at: Date.now(), catalog };
  return catalog;
}

/** Détecte le SKU dans un label / description (13 chiffres) */
function extractSku(label: string, description?: string): string | null {
  const combined = `${label || ''} ${description || ''}`;
  const m = combined.match(/\b(37\d{11})\b/);
  return m ? m[1] : null;
}

/**
 * Tente de retrouver le SKU d'une ligne devis à partir du catalogue quand
 * Claude n'a pas su l'ajouter (typique : accessoires, dont le SKU n'est
 * jamais énoncé dans les brouillons clients).
 *
 * Stratégie :
 *   1. Match par prix : trouver les entrées catalogue dont HT@vatPercent OU
 *      TTC égalent le prix saisi à 0,01 € près.
 *   2. Si une seule → on retourne son SKU.
 *   3. Si plusieurs → on désambigue par overlap de tokens entre le label
 *      saisi et le label catalogue (typologie / forme / matière / couleur /
 *      taille). Le meilleur score gagne — sauf ex-aequo → null (warning).
 *   4. Si zéro → null.
 */
function inferSkuFromCatalog(
  catalog: Record<string, { ttc: number; hts: number[]; label: string }>,
  priceInMail: number,
  vatColIdx: number,
  lineLabel: string,
): string | null {
  if (priceInMail <= 0) return null;
  const TOL = 0.01;

  // Étape 1 : shortlist des entrées dont le prix (HT à la bonne TVA OU TTC)
  // colle au prix saisi. Deux candidats possibles car Claude peut copier soit
  // le TTC (règle N°2), soit le HT s'il est marqué explicitement dans le mail.
  const candidates: string[] = [];
  for (const [sku, entry] of Object.entries(catalog)) {
    const htAtVat = vatColIdx >= 0 ? entry.hts[vatColIdx] : NaN;
    const htMatch = Number.isFinite(htAtVat) && Math.abs(htAtVat - priceInMail) <= TOL;
    const ttcMatch = Math.abs(entry.ttc - priceInMail) <= TOL;
    if (htMatch || ttcMatch) candidates.push(sku);
  }

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  // Étape 2 : désambiguer par overlap de tokens (label saisi ∩ label catalogue)
  const norm = (s: string) => s
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accents
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  const stopwords = new Set(['de', 'du', 'des', 'le', 'la', 'les', 'un', 'une', 'en', 'et', 'a', 'au', 'aux', 'sur', 'pour', 'avec', 'sans', 'pièce', 'piece', 'unité', 'unite']);
  const tokenize = (s: string) => norm(s).split(' ').filter((t) => t.length >= 3 && !stopwords.has(t));
  const lineTokens = new Set(tokenize(lineLabel));

  let best: { sku: string; score: number } | null = null;
  let tied = false;
  for (const sku of candidates) {
    const entry = catalog[sku];
    const catTokens = tokenize(entry.label);
    let score = 0;
    for (const t of catTokens) if (lineTokens.has(t)) score++;
    if (best === null || score > best.score) {
      best = { sku, score };
      tied = false;
    } else if (score === best.score) {
      tied = true;
    }
  }
  // Match unique (score strictement supérieur aux autres) OU tous égaux mais
  // 1 seule ligne dans la liste → retour du best. Sinon ambiguïté → null.
  if (best && !tied && best.score > 0) return best.sku;
  return null;
}

/**
 * POST /api/plugin/extract-quote
 * Extrait les données structurées d'un devis depuis le texte Claude + fil de mails.
 * Utilise Claude Haiku pour un parsing fiable, toutes langues confondues.
 */
export async function POST(req: NextRequest) {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json({ error: 'ANTHROPIC_API_KEY non configurée' }, { status: 500 });
    }

    const { claudeText, mailThread, customerEmail, customerName, storeCode } = await req.json();

    // Au moins UNE source (claudeText OU mailThread). Autorise le flow "Générer
    // devis PDF direct" depuis la page d'accueil du plugin (sans passer par
    // Analyser avec Claude) : dans ce cas claudeText est vide, mais mailThread
    // contient le fil complet, et la règle N°8 dit à Claude d'aller chercher
    // le chiffrage dans le mail antérieur si le "CHIFFRAGE SERVICE CLIENT"
    // est vide.
    if (!claudeText && !mailThread) {
      return NextResponse.json({ error: 'claudeText ou mailThread requis' }, { status: 400 });
    }

    const systemPrompt = `Tu extrais les données d'un devis depuis un mail de service client. Retourne un JSON structuré.

=== RÈGLE N°1 : STANDARD vs SUR MESURE ===
- STANDARD = taille existante au catalogue (ex: 2x3, 4x4, 3x6...). Unit = "piece", quantity = nombre d'unités commandées.
- SUR MESURE = dimensions personnalisées (ex: 3,41 x 1,76 m). Unit = "m2", quantity = surface totale en m².
  Si plusieurs filets SUR MESURE identiques : quantity = nombre × largeur × hauteur.
  Exemple : 10 filets de 3,41×1,76m → quantity = 10 × 3,41 × 1,76 = 60,02

=== RÈGLE N°2 : PRIX ===
- Tous les unitPrice doivent être en HT.
- Les prix de la grille sur mesure sont déjà en HT → copier tel quel.
- Les prix du catalogue standard sont en TTC dans le mail → copier le prix TTC dans unitPrice, mettre unit="piece". Le serveur convertira automatiquement en HT selon le SKU et la TVA du client.

=== RÈGLE N°2 BIS : SKU OBLIGATOIRE POUR LES STANDARDS ===
Pour CHAQUE ligne avec unit="piece" (standard catalogue), tu DOIS inclure le SKU (13 chiffres, commence par 37) dans la DESCRIPTION (PAS dans le label — le label reste propre avec juste le nom produit). Cherche le SKU dans le mail ou déduis-le depuis le fichier prix-ht-standards.txt en croisant typologie + forme + matière + couleur + taille. Format EXACT : description = "SKU : 3770030527170". Sans SKU, la conversion TTC→HT côté serveur est impossible.

=== RÈGLE N°3 : LABEL (TOUJOURS dans la langue de la boutique) ===
- Le brouillon est en français mais le label du devis PDF DOIT être dans la LANGUE DE LA BOUTIQUE.
- Boutique RED → espagnol. REDE → portugais. TAR → allemand. HET → néerlandais. RETE → italien. LFC/LVO/MON/UNI/COCO → français.
- Si plusieurs filets identiques, préfixer : "10 x Red de camuflaje..."
- Pour un seul filet, pas de préfixe.
- STANDARD : traduire le nom du produit dans la langue de la boutique.
- SUR MESURE : assembler depuis cette table EXACTE :
  Types : FR=Filet de camouflage | DE=Tarnnetz | NL=Camouflagenet | ES=Red de camuflaje | IT=Rete mimetica | PT=Rede de camuflagem | EN=Camouflage net
  Formes : FR=rectangulaire | DE=rechteckig | NL=rechthoekig | ES=rectangular | IT=rettangolare | PT=retangular | EN=rectangular
  FR=triangulaire | DE=dreieckig | NL=driehoekig | ES=triangular | IT=triangolare | PT=triangular | EN=triangular
  FR=trapézoïdal | DE=trapezförmig | NL=trapeziumvormig | ES=trapezoidal | IT=trapezoidale | PT=trapezoidal | EN=trapezoidal
  Finitions : FR=polyester | DE=Polyester | NL=polyester | ES=poliéster | IT=poliestere | PT=poliéster | EN=polyester
  FR=câble acier | DE=Stahlseil | NL=staalkabel | ES=cable de acero | IT=cavo d'acciaio | PT=cabo de aço | EN=steel cable
  FR=ignifugé | DE=schwer entflammbar | NL=brandvertragend | ES=ignífugo | IT=ignifugo | PT=ignífugo | EN=fire retardant
  Couleurs : FR=sable/DE=Beige/NL=Zand/ES=Arena/IT=Sabbia/PT=Areia | FR=blanc/DE=Weiß/NL=Wit/ES=Blanco/IT=Bianco/PT=Branco | FR=vert/DE=Grün/NL=Groen/ES=Verde/IT=Verde/PT=Verde | FR=noir/DE=Schwarz/NL=Zwart/ES=Negro/IT=Nero/PT=Preto | FR=gris/DE=Grau/NL=Grijs/ES=Gris/IT=Grigio/PT=Cinzento | FR=bleu/DE=Blau/NL=Blauw/ES=Azul/IT=Blu/PT=Azul | FR=militaire/DE=Bundeswehr/NL=Militair/ES=Militar/IT=Militare/PT=Militar
  Format : [Type] [forme] [dimensions], [couleur], [finition]

=== RÈGLE N°4 : PLUSIEURS OPTIONS ===
- Si le chiffrage contient PLUSIEURS OPTIONS (ex: option polyester + option câble acier), regarder le fil de mails pour trouver LAQUELLE le client a choisie. Extraire UNIQUEMENT l'option choisie.
- Si le client n'a pas encore choisi, extraire l'option la plus chère (câble acier > polyester).

=== RÈGLE N°5 : TRANSPORT + REMISE ===
- Livraison offerte → 1 ligne "transport" + 1 ligne "transport_discount" (même montant en négatif).
- Remise globale (ex: -10%) → champ "discountPercent", PAS une ligne dans "lines".

=== RÈGLE N°5 : DESCRIPTION ===
- SUR MESURE : description = "Quantité : X | Total m² : Y | Délai de production + livraison : environ 21 jours"
- STANDARD : description = "SKU : xxxxxxxxxxxxx" (cf. règle N°2 BIS — le SKU va SUR SA PROPRE LIGNE en description, pour lisibilité du devis PDF et parsing serveur TTC→HT).

=== RÈGLE N°7 : COORDONNÉES CLIENT ===
- Chercher le téléphone, nom, prénom, adresse dans TOUT le fil de mails (y compris le PREMIER message, souvent un formulaire de contact avec le numéro de téléphone).
- Ne pas se limiter au dernier message.
- ENTREPRISE FRANÇAISE : chercher aussi le SIRET (14 chiffres, souvent en signature, en pied de mail, ou dans un mail administratif). Le n° TVA intra FR est distinct du SIRET (le n° TVA FR est 13 caractères FRxxxxxxxxxxx et contient 11 chiffres du SIRET après la clé, mais on saisit les 2 séparément). Format attendu : suite de 14 chiffres consécutifs (avec ou sans espaces à retirer). Si non trouvé, laisser vide — on ne l'invente pas.

=== RÈGLE N°7 BIS : ADRESSE DE FACTURATION vs ADRESSE DE LIVRAISON ===
- Le client PEUT avoir 2 adresses distinctes : facturation (siège social, domicile administratif) et livraison (chantier, entrepôt, second domicile). Chercher les 2 dans le fil.
- billingAddress = OBLIGATOIRE (adresse principale, comptable). Si le client n'a donné qu'une adresse, c'est celle-là.
- deliveryAddress = OPTIONNEL. Ne le remplir QUE si le fil mentionne EXPLICITEMENT une adresse de livraison distincte : phrases type « à livrer à », « livraison à l'adresse suivante », « pour la livraison », « chantier à », « merci de livrer chez… ». Si le client mentionne SEULEMENT une adresse ou dit « livraison à la même adresse » : deliveryAddress = null.
- Ne PAS inventer une deliveryAddress. En cas de doute → null.

=== RÈGLE N°8 : OÙ EST LE CHIFFRAGE ===
- Le « CHIFFRAGE SERVICE CLIENT » ci-dessous correspond au DERNIER message Claude, qui peut être une simple clarification, une question de relance ou une confirmation de commande SANS prix.
- Si ce dernier message ne contient PAS de prix/taille/quantité explicite, alors le chiffrage est forcément dans un MAIL ANTÉRIEUR du fil — CHERCHER dans « MAILS » le message NOUS le plus récent qui contient les détails du devis (taille, couleur, finition, prix HT/TTC, quantité, transport, kit/accessoire éventuels).

- **RÈGLE ABSOLUE — reflète EXACTEMENT le dernier chiffrage QUE NOUS AVONS ENVOYÉ au client**, sans ajouter les demandes en attente de validation :
  * Si le client a demandé une remise, un code promo, un ajout d'accessoire, un changement de couleur, un rabais commercial APRÈS notre dernier chiffrage, et que NOUS N'AVONS PAS RÉPONDU en validant cette modification dans un nouveau chiffrage → tu n'appliques PAS la demande. Le devis PDF doit refléter fidèlement le dernier chiffrage envoyé au client (montant TTC identique).
  * discountPercent = 0 dans ce cas (aucune remise), même si le client a fait la demande. C'est au gérant de trancher côté service client, pas à toi côté extraction.
  * En revanche : si le client a demandé une modification ET nous lui avons ENVOYÉ un nouveau chiffrage validant cette modif → tu prends bien ce nouveau chiffrage validé (avec la remise/le code/le nouvel accessoire chiffré).

- Ne JAMAIS retourner un JSON vide en disant "rien trouvé" si le fil de mails contient un devis : extraire ce devis tel que nous l'avons envoyé au client.

Cas déclencheur (à NE PAS reproduire) : cnv_1lrsjtnb (LFC, 03/07/2026) — Isabelle Boxelé. Notre dernier chiffrage envoyé : Filet 3,0×2,5 m HT 161,93 € + TVA 20 % = 194,31 € TTC, PAS de remise. La cliente répond en demandant « une remise de 15 % que vous avez mentionnée dans un précédent mail, est-elle encore valable ? ». Cette demande N'A PAS ÉTÉ VALIDÉE par notre service client. Le devis PDF doit sortir avec Total TTC = 194,31 € (comme notre mail), pas 165,17 € (mail moins 15 %). discountPercent = 0. Le gérant décidera manuellement s'il applique la remise dans un second temps.

Réponds UNIQUEMENT avec le JSON, sans texte ni backticks.`;

    const userMessage = `Extrait les données du devis.

Client : ${customerName || '?'} — ${customerEmail || '?'}
Boutique : ${storeCode || '?'}

--- MAILS ---
${mailThread || '(aucun)'}

--- CHIFFRAGE SERVICE CLIENT ---
${claudeText || '(aucun chiffrage service client — extraire depuis le fil de mails ci-dessus, cf. règle N°8)'}

--- JSON ATTENDU ---
{
  "store": "${storeCode || ''}",
  "customer": {
    "type": "individual|company",
    "firstName": "", "lastName": "", "companyName": "",
    "email": "", "phone": "", "vatNumber": "", "siret": "",
    "billingAddress": { "address": "", "postalCode": "", "city": "", "country": "XX" },
    "deliveryAddress": null
  },
  "vatPercent": 0,
  "discountPercent": 0,
  "totalTTC": 0,
  "lines": [
    { "type": "product|accessory|transport|transport_discount", "label": "", "quantity": 0, "unitPrice": 0, "unit": "m2|piece", "description": "" }
  ]
}

Note : "deliveryAddress" doit être :
- null (par défaut, si pas d'adresse de livraison distincte dans le fil)
- OU un objet {"address": "...", "postalCode": "...", "city": "...", "country": "XX"} si le fil mentionne EXPLICITEMENT une livraison à une autre adresse.`;

    console.log(`[extract-quote] calling Claude Sonnet for store=${storeCode}`);
    const t0 = Date.now();

    // maxTokens bumped 2000 → 4000 : sur un devis multi-produit + adresses
    // + description sur-mesure + SKU, le JSON peut dépasser 2000 tokens et
    // se retrouver tronqué → parse KO (cas cnv_1lrhbkif 03/07/2026 Melanie
    // Bulfon, "Réponse Claude invalide" après plusieurs tentatives).
    let result = await callClaude(
      [{ role: 'user', content: userMessage }],
      { model: 'claude-sonnet-4-6', maxTokens: 4000, system: systemPrompt }
    );

    console.log(`[extract-quote] done in ${Date.now() - t0}ms, result length=${result.length}`);

    /**
     * Parse robuste du JSON Claude. Sonnet ajoute parfois un préambule
     * ("Voici le JSON extrait :"), des backticks ```json …```, ou un
     * postambule ("N'hésitez pas si…"). On tente plusieurs stratégies :
     *   1. Retirer wrappers ```json/``` puis JSON.parse direct.
     *   2. Localiser le premier '{' et le dernier '}' balanced, extraire
     *      la sous-chaîne, JSON.parse.
     *   3. Retry auto avec une instruction stricte "JSON only, no other
     *      text" si l'étape 2 échoue.
     */
    const tryParseFlexible = (raw: string): unknown | null => {
      const cleaned = raw
        .replace(/^```json\s*\n?/i, '')
        .replace(/^```\s*\n?/i, '')
        .replace(/\n?\s*```$/i, '')
        .trim();
      try { return JSON.parse(cleaned); } catch { /* try next strategy */ }
      // Trouver le premier { et scanner à la recherche de la } équilibrée
      const start = cleaned.indexOf('{');
      if (start < 0) return null;
      let depth = 0;
      let end = -1;
      let inString = false;
      let escape = false;
      for (let i = start; i < cleaned.length; i++) {
        const c = cleaned[i];
        if (inString) {
          if (escape) { escape = false; continue; }
          if (c === '\\') { escape = true; continue; }
          if (c === '"') inString = false;
          continue;
        }
        if (c === '"') { inString = true; continue; }
        if (c === '{') depth++;
        else if (c === '}') {
          depth--;
          if (depth === 0) { end = i; break; }
        }
      }
      if (end < 0) return null;
      const blob = cleaned.substring(start, end + 1);
      try { return JSON.parse(blob); } catch { return null; }
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let parsed: any = tryParseFlexible(result);

    // Retry auto avec instruction JSON-only si le premier appel a produit
    // un texte non parseable (Sonnet peut se laisser aller à commenter).
    if (!parsed) {
      console.warn('[extract-quote] premier parse KO — retry avec instruction JSON-only');
      const strictSystem = systemPrompt + '\n\nATTENTION : ta réponse DOIT être UNIQUEMENT le JSON, sans texte avant ni après, sans backticks, sans commentaire. Commence directement par { et termine par }. Aucune exception.';
      result = await callClaude(
        [{ role: 'user', content: userMessage }],
        { model: 'claude-sonnet-4-6', maxTokens: 4000, system: strictSystem }
      );
      parsed = tryParseFlexible(result);
    }

    if (!parsed) {
      console.error('[extract-quote] JSON parse KO même après retry — raw sample:', result.substring(0, 500));
      return NextResponse.json({ error: 'Réponse Claude invalide (JSON non parseable après retry)', raw: result.substring(0, 1000) }, { status: 500 });
    }

    // Rétrocompat : si Claude sort encore l'ancienne clé "address" au lieu
    // de "billingAddress" (schéma pré-refacto 02/07/2026), on la mappe. Vise
    // les appels legacy ou les cache-hits du prompt qui n'a pas encore
    // "propagé" la nouvelle règle N°7 BIS.
    if (parsed?.customer && !parsed.customer.billingAddress && parsed.customer.address) {
      parsed.customer.billingAddress = parsed.customer.address;
      delete parsed.customer.address;
    }
    if (parsed?.customer && parsed.customer.deliveryAddress === undefined) {
      parsed.customer.deliveryAddress = null;
    }

    // Post-processing STANDARDS : convertir le TTC saisi par Claude en HT via
    // le SKU + le taux TVA. Claude est censé écrire le TTC affiché dans le mail
    // + le SKU dans le label. Le serveur lit le prix-ht-standards.txt du store,
    // vérifie la cohérence TTC catalogue vs TTC saisi, et remplace unitPrice
    // par le vrai HT selon la TVA du client.
    //
    // Warnings orange (non bloquants) émis dans warnings[] renvoyé au client :
    //  - Aucun SKU dans le label → fallback : on garde le prix tel quel (comportement d'avant)
    //  - SKU introuvable au catalogue → fallback idem
    //  - TTC catalogue ≠ TTC saisi (tolérance 0,01 €) → on applique quand même
    //    le HT catalogue (catalogue prioritaire) + warning
    //  - Taux TVA absent des 12 colonnes du fichier → fallback
    const warnings: string[] = [];

    // Post-processing SUR-MESURE : la règle CLAUDE.md impose surface au dixième
    // de m² (« DIMENSIONS : on travaille UNIQUEMENT au dixième de mètre, jamais
    // plus fin »). Le prompt N°1 demande à Claude de calculer nombre × largeur
    // × hauteur → renvoie 19.24 pour 3.7×5.2 par exemple. Le mail que le
    // service client a envoyé au client, LUI, affiche 19,2 (arrondi). Le devis
    // PDF DOIT reprendre la valeur du mail sinon on décale de quelques cents
    // sur le Total HT (cas cnv_1lrf14if : mail 19,2×15,50=297,60 ; form
    // 19,24×15,50=298,22 → +0,62 € non annoncé).
    //
    // Fix serveur (déterministe) : pour chaque ligne unit=m2, arrondir
    // quantity au dixième + mettre à jour la description « Total m² : X ».
    if (Array.isArray(parsed?.lines)) {
      for (const line of parsed.lines) {
        if (line?.unit !== 'm2') continue;
        const rawQty = Number(line.quantity);
        if (!Number.isFinite(rawQty) || rawQty <= 0) continue;
        const roundedQty = Math.round(rawQty * 10) / 10;
        if (Math.abs(roundedQty - rawQty) > 0.001) {
          line.quantity = roundedQty;
          console.log(`[extract-quote] surface arrondie au dixième : ${rawQty} → ${roundedQty} m² (ligne "${(line.label || '').substring(0, 40)}")`);
        }
        // Réécrire "Total m² : XXX" dans la description avec la valeur
        // arrondie. Regex insensible aux séparateurs (virgule/point) et
        // aux chiffres après la virgule d'origine. Format sortie français
        // (virgule) pour cohérence avec l'affichage mail.
        const desc = String(line.description || '');
        const totalRe = /(Total m²\s*:\s*)([\d.,]+)/i;
        if (totalRe.test(desc)) {
          const fmt = roundedQty.toFixed(1).replace('.', ',');
          line.description = desc.replace(totalRe, `$1${fmt}`);
        }
        // Arrondir aussi les DIMENSIONS dans le label : « 2,49 × 3,84 m »
        // → « 2,5 × 3,8 m ». Même règle CLAUDE.md que la surface : on
        // travaille au dixième de mètre pour éviter les fausses précisions
        // (le filet est fabriqué à ±5 cm de toute façon).
        // Formats acceptés en entrée (2 à 4 dimensions) :
        //   « 2.49 x 3.84 m »              (rectangle 2 dims)
        //   « 6,9 x 6,9 x 3,8 m »           (triangle 3 dims)
        //   « 6,65×4,2×5,4×5,2 m »          (trapèze / quadrilatère 4 dims)
        // Bug fix 07/07/2026 (cnv_1lpx6z13, RETE, Alessandro Lombardini) :
        // l'ancienne regex ne capturait que 2 ou 3 dimensions → le trapèze
        // à 4 dims restait avec « 6,65 » (au centième) au lieu de « 6,7 »
        // (au dixième), incohérent avec la règle d'arrondi appliquée à
        // la surface (23,5 m² dans ce cas).
        const label = String(line.label || '');
        const dimRe = /((?:\d+[.,]\d+)(?:\s*[x×X]\s*\d+[.,]\d+){1,3})(\s*m\b)/;
        const dm = label.match(dimRe);
        if (dm) {
          const roundToStr = (s: string) => {
            const n = parseFloat(s.replace(',', '.'));
            if (!Number.isFinite(n)) return s;
            const sep = s.includes(',') ? ',' : '.';
            return (Math.round(n * 10) / 10).toFixed(1).replace('.', sep);
          };
          // Split le bloc dimensions en gardant les séparateurs (×/x) intacts.
          // Ex : "6,65×4,2×5,4×5,2" → ["6,65", "×", "4,2", "×", "5,4", "×", "5,2"]
          // Indices pairs = valeurs à arrondir, indices impairs = séparateurs.
          const parts = dm[1].split(/(\s*[x×X]\s*)/);
          const roundedBlock = parts
            .map((p, i) => (i % 2 === 0 ? roundToStr(p) : p))
            .join('');
          const rebuilt = `${roundedBlock}${dm[2]}`;
          if (rebuilt !== dm[0]) {
            line.label = label.replace(dimRe, rebuilt);
            console.log(`[extract-quote] dimensions arrondies au dixième : "${dm[0]}" → "${rebuilt}"`);
          }
        }
      }
    }

    try {
      if (storeCode && Array.isArray(parsed?.lines)) {
        const catalog = await loadPriceCatalog(storeCode);
        const vatPercent = typeof parsed.vatPercent === 'number' ? parsed.vatPercent : 20;
        const vatColIdx = vatColumnIndex(vatPercent);

        for (let i = 0; i < parsed.lines.length; i++) {
          const line = parsed.lines[i];
          if (line?.unit !== 'piece') continue; // sur-mesure et autres inchangés

          const priceInMail = Number(line.unitPrice) || 0;

          // Skip les lignes hors périmètre catalogue :
          //  - type transport / transport_discount : ce sont des services de
          //    livraison, pas des produits catalogue (pas de SKU attendu).
          //  - unitPrice = 0 : ligne "gratuite" (livraison offerte, remise,
          //    etc.), rien à vérifier côté prix.
          const lineType = String(line.type || '').toLowerCase();
          if (lineType === 'transport' || lineType === 'transport_discount' || priceInMail === 0) {
            continue;
          }

          let sku = extractSku(String(line.label || ''), String(line.description || ''));

          // Auto-inférence si Claude n'a pas mis le SKU (typique : accessoires
          // dont le SKU n'est jamais écrit dans les brouillons clients).
          // On tente de retrouver le SKU dans le catalogue par match sur le
          // prix (HT@vatPercent ou TTC), désambigué au besoin par overlap
          // token label saisi ∩ label catalogue. Si un SKU unique sort → on
          // l'injecte dans la description et on continue le flow normal.
          if (!sku) {
            const inferred = inferSkuFromCatalog(catalog, priceInMail, vatColIdx, String(line.label || ''));
            if (inferred) {
              sku = inferred;
              const currentDesc = String(line.description || '').trim();
              const skuLine = `SKU : ${inferred}`;
              line.description = currentDesc ? `${currentDesc} | ${skuLine}` : skuLine;
              console.log(`[extract-quote] SKU ${inferred} auto-inféré pour ligne "${(line.label || '').substring(0, 40)}" (prix ${priceInMail} €)`);
            } else {
              warnings.push(`⚠️ Ligne "${(line.label || '').substring(0, 60)}" : SKU manquant et inférence catalogue impossible (aucune ligne du store ${storeCode} n'égale ${priceInMail.toFixed(2)} € en HT ou TTC). Complète manuellement la description avec « SKU : xxxxxxxxxxxxx ».`);
              continue;
            }
          }
          let entry = catalog[sku];
          if (!entry) {
            warnings.push(`⚠️ Ligne "${(line.label || '').substring(0, 60)}" (SKU ${sku}) : SKU introuvable dans prix-ht-standards.txt du store ${storeCode} → prix conservé (${priceInMail.toFixed(2)} €). Vérifie que le SKU est correct.`);
            continue;
          }
          if (vatColIdx < 0) {
            warnings.push(`⚠️ Ligne "${(line.label || '').substring(0, 60)}" (SKU ${sku}) : taux TVA ${vatPercent} % non couvert par le catalogue → prix conservé (${priceInMail.toFixed(2)} €). Taux disponibles : ${VAT_RATES.join(', ')}.`);
            continue;
          }

          // Vérif cohérence prix saisi ≈ prix catalogue (tolérance 0,01 €).
          // Le mail peut annoncer le prix soit en TTC (règle N°2), soit en HT
          // (cas où le mail explicite « Prix HT : 24,92 € »). Les 2 sont OK
          // tant que priceInMail colle à l'une des 2 valeurs catalogue au
          // taux TVA du client. Le warning ne s'émet que si NI TTC NI HT ne
          // matchent (vrai désalignement à faire vérifier au gérant).
          //
          // Cas déclencheur (cnv_1lnmfndj, Kit fixation LFC) : mail écrit
          // « Prix HT : 24,92 € » → priceInMail=24.92 = HT@20 % catalogue,
          // mais entry.ttc=29.90 → warning "TTC saisi ≠ TTC catalogue" tirait
          // à tort alors que le HT correspondait exactement. Fix : accepter
          // les 2 angles.
          let catalogHT = entry.hts[vatColIdx];
          let matchesTtc = Math.abs(entry.ttc - priceInMail) <= 0.01;
          let matchesHt = Math.abs(catalogHT - priceInMail) <= 0.01;

          // Cas Charles 08/07/2026 (cnv_1lsco05z, LFC) : Claude Haiku a écrit
          // le SKU 3770030527170 (sable 4x7, TTC 279,99) dans la description
          // d'une ligne « 4×5 militaire polyester » à 199,99 €. L'ancien code
          // se contentait de warner puis d'appliquer le HT du MAUVAIS SKU
          // (233,33 € au lieu de 166,66 € → surfacturation 66,67 €/pièce).
          // Fix : quand le prix ne matche pas, on tente une ré-inférence à
          // partir du couple (prix, label). Si le catalogue a un SKU dont
          // le prix ET le label collent, on remplace silencieusement le
          // SKU de Claude par le bon SKU. Warning informatif.
          if (!matchesTtc && !matchesHt) {
            const reinferred = inferSkuFromCatalog(catalog, priceInMail, vatColIdx, String(line.label || ''));
            if (reinferred && reinferred !== sku && catalog[reinferred]) {
              const newEntry = catalog[reinferred];
              console.log(`[extract-quote] SKU corrigé : ${sku} (TTC ${entry.ttc}) → ${reinferred} (TTC ${newEntry.ttc}) via label "${(line.label || '').substring(0, 40)}" à ${priceInMail} €`);
              warnings.push(`ℹ️ Ligne "${(line.label || '').substring(0, 60)}" : SKU auto-corrigé (${sku} → ${reinferred}) — le prix saisi ${priceInMail.toFixed(2)} € matchait mieux avec le catalogue à ${reinferred}. Vérifie que ce SKU correspond bien au produit demandé.`);
              const oldDesc = String(line.description || '');
              line.description = oldDesc.includes(sku)
                ? oldDesc.replace(new RegExp(sku.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), reinferred)
                : (oldDesc ? `${oldDesc} | SKU : ${reinferred}` : `SKU : ${reinferred}`);
              sku = reinferred;
              entry = newEntry;
              catalogHT = entry.hts[vatColIdx];
              matchesTtc = Math.abs(entry.ttc - priceInMail) <= 0.01;
              matchesHt = Math.abs(catalogHT - priceInMail) <= 0.01;
            } else {
              warnings.push(
                `⚠ Ligne "${(line.label || '').substring(0, 60)}" (SKU ${sku}) : prix saisi ${priceInMail.toFixed(2)} € ≠ catalogue (TTC ${entry.ttc.toFixed(2)} € / HT ${catalogHT.toFixed(2)} € à ${vatPercent} %). Le HT catalogue est appliqué. Vérifie que le mail n'a pas annoncé un montant différent au client.`
              );
            }
          }

          const oldPrice = line.unitPrice;
          line.unitPrice = catalogHT;
          console.log(`[extract-quote] SKU ${sku} : ${oldPrice} € → HT ${line.unitPrice} € (TVA ${vatPercent} %)${matchesTtc ? ' [saisi=TTC catalogue]' : matchesHt ? ' [saisi=HT catalogue, pas de warning]' : ' [désaligné → warning]'}`);
        }
      }
    } catch (postErr) {
      console.warn('[extract-quote] post-processing (SKU → HT) failed:', postErr);
      warnings.push(`Erreur interne lors de la vérification catalogue : ${(postErr as Error).message || postErr}. Prix conservés tels quels.`);
    }

    return NextResponse.json({ ...parsed, warnings });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Erreur inconnue';
    console.error('[extract-quote] error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
