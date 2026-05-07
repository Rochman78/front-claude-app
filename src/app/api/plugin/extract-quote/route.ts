import { NextRequest, NextResponse } from 'next/server';
import { callClaude } from '@/lib/services/claudeService';

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

    if (!claudeText) {
      return NextResponse.json({ error: 'claudeText requis' }, { status: 400 });
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
- Les prix du catalogue standard sont en TTC → NE PAS les copier comme HT.
  Pour les produits standard, copier le prix TTC et mettre unit="piece".

=== RÈGLE N°3 : LABEL ===
- Si plusieurs filets identiques, préfixer : "10 x Filet de camouflage..."
- Pour un seul filet, pas de préfixe.
- STANDARD : copier le nom du produit tel qu'il apparaît dans le texte.
- SUR MESURE en langue étrangère, assembler depuis cette table EXACTE :
  Types : FR=Filet de camouflage | DE=Tarnnetz | NL=Camouflagenet | ES=Red de camuflaje | IT=Rete mimetica | PT=Rede de camuflagem | EN=Camouflage net
  Formes : FR=rectangulaire | DE=rechteckig | NL=rechthoekig | ES=rectangular | IT=rettangolare | PT=retangular | EN=rectangular
  FR=triangulaire | DE=dreieckig | NL=driehoekig | ES=triangular | IT=triangolare | PT=triangular | EN=triangular
  FR=trapézoïdal | DE=trapezförmig | NL=trapeziumvormig | ES=trapezoidal | IT=trapezoidale | PT=trapezoidal | EN=trapezoidal
  Finitions : FR=polyester | DE=Polyester | NL=polyester | ES=poliéster | IT=poliestere | PT=poliéster | EN=polyester
  FR=câble acier | DE=Stahlseil | NL=staalkabel | ES=cable de acero | IT=cavo d'acciaio | PT=cabo de aço | EN=steel cable
  FR=ignifugé | DE=schwer entflammbar | NL=brandvertragend | ES=ignífugo | IT=ignifugo | PT=ignífugo | EN=fire retardant
  Couleurs : FR=sable/DE=Beige/NL=Zand/ES=Arena/IT=Sabbia/PT=Areia | FR=blanc/DE=Weiß/NL=Wit/ES=Blanco/IT=Bianco/PT=Branco | FR=vert/DE=Grün/NL=Groen/ES=Verde/IT=Verde/PT=Verde | FR=noir/DE=Schwarz/NL=Zwart/ES=Negro/IT=Nero/PT=Preto | FR=gris/DE=Grau/NL=Grijs/ES=Gris/IT=Grigio/PT=Cinzento | FR=bleu/DE=Blau/NL=Blauw/ES=Azul/IT=Blu/PT=Azul | FR=militaire/DE=Bundeswehr/NL=Militair/ES=Militar/IT=Militare/PT=Militar
  Format : [Type] [forme] [dimensions], [couleur], [finition]

=== RÈGLE N°4 : TRANSPORT + REMISE ===
- Livraison offerte → 1 ligne "transport" + 1 ligne "transport_discount" (même montant en négatif).
- Remise globale (ex: -10%) → champ "discountPercent", PAS une ligne dans "lines".

=== RÈGLE N°5 : DESCRIPTION ===
- SUR MESURE uniquement : description = "Quantité : X | Total m² : Y | Délai de production + livraison : environ 14 jours"
- STANDARD : pas de description.

Réponds UNIQUEMENT avec le JSON, sans texte ni backticks.`;

    const userMessage = `Extrait les données du devis.

Client : ${customerName || '?'} — ${customerEmail || '?'}
Boutique : ${storeCode || '?'}

--- MAILS ---
${mailThread || '(aucun)'}

--- CHIFFRAGE SERVICE CLIENT ---
${claudeText}

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

    return NextResponse.json(parsed);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Erreur inconnue';
    console.error('[extract-quote] error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
