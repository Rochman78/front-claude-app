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

=== RÈGLE N°8 : OÙ EST LE CHIFFRAGE ===
- Le « CHIFFRAGE SERVICE CLIENT » ci-dessous correspond au DERNIER message Claude, qui peut être une simple clarification, une question de relance ou une confirmation de commande SANS prix.
- Si ce dernier message ne contient PAS de prix/taille/quantité explicite, alors le chiffrage est forcément dans un MAIL ANTÉRIEUR du fil — CHERCHER dans « MAILS » le message NOUS le plus récent qui contient les détails du devis (taille, couleur, finition, prix HT/TTC, quantité, transport, kit/accessoire éventuels).
- Si le client a demandé une modification depuis ce devis (changement de couleur, ajout d'accessoire, code promo…), appliquer ces modifications au chiffrage extrait.
- Ne JAMAIS retourner un JSON vide en disant "rien trouvé" si le fil de mails contient un devis : extraire ce devis et appliquer les modifications mentionnées.

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
    "email": "", "phone": "", "vatNumber": "",
    "address": { "address": "", "postalCode": "", "city": "", "country": "XX" }
  },
  "vatPercent": 0,
  "discountPercent": 0,
  "totalTTC": 0,
  "lines": [
    { "type": "product|accessory|transport|transport_discount", "label": "", "quantity": 0, "unitPrice": 0, "unit": "m2|piece", "description": "" }
  ]
}`;

    console.log(`[extract-quote] calling Claude Haiku for store=${storeCode}`);
    const t0 = Date.now();

    const result = await callClaude(
      [{ role: 'user', content: userMessage }],
      { model: 'claude-sonnet-4-6', maxTokens: 2000, system: systemPrompt }
    );

    console.log(`[extract-quote] done in ${Date.now() - t0}ms, result length=${result.length}`);

    // Parser le JSON retourné par Claude
    let parsed;
    try {
      // Nettoyer au cas où Claude ajoute des backticks
      const cleaned = result.replace(/^```json\s*\n?/, '').replace(/\n?\s*```$/, '').trim();
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error('[extract-quote] JSON parse error:', parseErr, 'raw:', result.substring(0, 500));
      return NextResponse.json({ error: 'Réponse Claude invalide', raw: result }, { status: 500 });
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
    try {
      if (storeCode && Array.isArray(parsed?.lines)) {
        const catalog = await loadPriceCatalog(storeCode);
        const vatPercent = typeof parsed.vatPercent === 'number' ? parsed.vatPercent : 20;
        const vatColIdx = vatColumnIndex(vatPercent);

        for (let i = 0; i < parsed.lines.length; i++) {
          const line = parsed.lines[i];
          if (line?.unit !== 'piece') continue; // sur-mesure et autres inchangés

          const priceInMail = Number(line.unitPrice) || 0;
          const sku = extractSku(String(line.label || ''), String(line.description || ''));

          if (!sku) {
            warnings.push(`Ligne "${(line.label || '').substring(0, 60)}" : aucun SKU détecté dans le label → prix conservé tel quel (${priceInMail} €). Ajoute manuellement le SKU pour vérification.`);
            continue;
          }
          const entry = catalog[sku];
          if (!entry) {
            warnings.push(`Ligne "${(line.label || '').substring(0, 60)}" (SKU ${sku}) : SKU introuvable dans le catalogue du store ${storeCode} → prix conservé (${priceInMail} €).`);
            continue;
          }
          if (vatColIdx < 0) {
            warnings.push(`Ligne "${(line.label || '').substring(0, 60)}" (SKU ${sku}) : taux TVA ${vatPercent} % non couvert par le catalogue (taux disponibles : ${VAT_RATES.join(', ')}) → prix conservé.`);
            continue;
          }

          // Vérif cohérence TTC saisi ≈ TTC catalogue (tolérance 0,01 €)
          if (Math.abs(entry.ttc - priceInMail) > 0.01) {
            warnings.push(
              `⚠ Ligne "${(line.label || '').substring(0, 60)}" (SKU ${sku}) : TTC saisi ${priceInMail.toFixed(2)} € ≠ TTC catalogue ${entry.ttc.toFixed(2)} €. Le HT catalogue est utilisé (${entry.hts[vatColIdx].toFixed(2)} € HT à ${vatPercent} %). Vérifie que le mail n'a pas annoncé un montant différent au client.`
            );
          }

          const oldPrice = line.unitPrice;
          line.unitPrice = entry.hts[vatColIdx];
          console.log(`[extract-quote] SKU ${sku} : ${oldPrice} € → HT ${line.unitPrice} € (TVA ${vatPercent} %)`);
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
