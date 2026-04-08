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

    const systemPrompt = `Tu es un extracteur de données de devis. Tu analyses le texte d'une conversation (mail client + réponse du service client) et tu extrais les informations du devis au format JSON.

RÈGLES STRICTES :
- Extrais UNIQUEMENT les données présentes dans le texte. N'invente RIEN.
- Les prix doivent correspondre EXACTEMENT à ceux du texte (pas de recalcul).
- Chaque produit/accessoire = une ligne séparée dans "lines".
- Le type de ligne est "product" pour les filets/produits principaux, "accessory" pour les accessoires (kits, câbles, etc.).
- IMPORTANT pour les filets/redes/Tarnnetz/net/rete (unit="m2") : "quantity" = surface TOTALE en m² (nombre de pièces × largeur × hauteur). NE JAMAIS mettre le nombre de pièces dans quantity. Exemples :
  - FR : "Quantité : 3, Superficie totale : 33,06 m²" → quantity = 33.06
  - ES : "Cantidad: 3, Superficie total: 33,06 m²" → quantity = 33.06
  - DE : "Menge: 3, Gesamtfläche: 33,06 m²" → quantity = 33.06
  - NL : "Aantal: 3, Totale oppervlakte: 33,06 m²" → quantity = 33.06
  - IT : "Quantità: 3, Superficie totale: 33,06 m²" → quantity = 33.06
  Le champ "unitPrice" = prix HT par m².
- Si la livraison est offerte/gratuite, ajoute une ligne type "transport" et une ligne "transport_discount" avec le même montant en négatif.
- Les labels des produits (champ "label") et le sujet (champ "subject") doivent être rédigés dans la LANGUE DU CLIENT (la langue utilisée dans la réponse service client). Ne traduis PAS en français si le texte est en néerlandais, allemand, espagnol, italien, etc.
- Réponds UNIQUEMENT avec le JSON, sans texte avant ou après, sans backticks.`;

    const userMessage = `Extrait les données du devis depuis ce texte.

Client connu : ${customerName || '(inconnu)'} — ${customerEmail || '(inconnu)'}
Boutique : ${storeCode || '(inconnue)'}

--- FIL DE MAILS ---
${mailThread || '(aucun)'}

--- RÉPONSE SERVICE CLIENT (contient le chiffrage) ---
${claudeText}

--- FORMAT JSON ATTENDU ---
{
  "store": "CODE_BOUTIQUE",
  "customer": {
    "type": "individual" ou "company",
    "firstName": "",
    "lastName": "",
    "companyName": "",
    "email": "",
    "phone": "",
    "vatNumber": "",
    "address": {
      "address": "rue",
      "postalCode": "",
      "city": "",
      "country": "CODE ISO 2 lettres"
    }
  },
  "subject": "sujet court du devis",
  "vatPercent": nombre (ex: 21),
  "lines": [
    {
      "type": "product|accessory|transport|transport_discount",
      "label": "description du produit",
      "quantity": nombre (IMPORTANT pour les filets/produits en m² : quantity = surface TOTALE en m², PAS le nombre de pièces. Ex : 3 filets de 2.90×3.80m → quantity = 3 × 2.90 × 3.80 = 33.06),
      "unitPrice": "prix unitaire HT par m² en string",
      "unit": "m2 ou piece"
    }
  ]
}`;

    console.log(`[extract-quote] calling Claude Haiku for store=${storeCode}`);
    const t0 = Date.now();

    const result = await callClaude(
      [{ role: 'user', content: userMessage }],
      { model: 'claude-haiku-4-5-20251001', maxTokens: 2000, system: systemPrompt }
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
