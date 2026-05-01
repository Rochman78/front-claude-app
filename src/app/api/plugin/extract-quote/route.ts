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
- Les prix doivent correspondre EXACTEMENT à ceux du texte. NE FAIS AUCUNE CONVERSION HT/TTC. Copie le prix tel quel.
- Chaque produit/accessoire = une ligne séparée dans "lines".
- Le type de ligne est "product" pour les filets/produits principaux, "accessory" pour les accessoires (kits, câbles, etc.).
- IMPORTANT — LIGNES SÉPARÉES PAR FILET : si le devis contient plusieurs filets avec des DIMENSIONS DIFFÉRENTES, créer UNE LIGNE PAR FILET (pas une ligne fusionnée). Exemple : Filet n°1 (3,80x7,50m = 28,50 m²) + Filet n°2 (7,50x7,10m = 53,25 m²) → 2 lignes, pas 1. Si les filets sont IDENTIQUES (mêmes dimensions), une seule ligne suffit avec quantity = surface totale.
- Pour chaque ligne filet (unit="m2") : "quantity" = surface de CE filet (ou surface totale si filets identiques). "unitPrice" = prix par m² tel qu'indiqué dans le texte (ne pas convertir).
  Exemples de quantity :
  - 3 filets IDENTIQUES de 2.90×3.80m → 1 ligne, quantity = 3×2.90×3.80 = 33.06
  - 1 filet 3.80×7.50m + 1 filet 7.50×7.10m → 2 lignes, quantity = 28.50 et 53.25
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
  "discountPercent": nombre ou 0 (remise globale en % si mentionnée, ex: 10 pour -10%),
  "totalTTC": nombre (le montant TTC FINAL après remise mentionné dans le chiffrage, ex: 530.46),
  "lines": [
    {
      "type": "product|accessory|transport|transport_discount",
      "label": "description du produit",
      "quantity": nombre (IMPORTANT pour les filets/produits en m² : quantity = surface TOTALE en m², PAS le nombre de pièces. Ex : 3 filets de 2.90×3.80m → quantity = 3 × 2.90 × 3.80 = 33.06),
      "unitPrice": "prix unitaire tel quel du texte (ne pas convertir HT/TTC)",
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
