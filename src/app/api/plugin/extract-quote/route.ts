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
- PRIX ACCESSOIRES : pour les accessoires (type "accessory", unit "piece"), le unitPrice doit être le prix HT. Consulter le TABLEAU DES PRIX HT ACCESSOIRES dans les documents de référence : chercher la ligne de l'accessoire + la colonne du taux de TVA du client. Copier le prix HT DIRECTEMENT du tableau, ne faire AUCUN calcul.
- PRIX FILETS SUR MESURE : le unitPrice est déjà en HT (grille de prix sur mesure), le copier tel quel.
- TRANSPORT : utiliser le prix HT du transport depuis le tableau "TRANSPORT SUR MESURE" selon le taux de TVA.
- Chaque produit/accessoire = une ligne séparée dans "lines".
- Le type de ligne est "product" pour les filets/produits principaux, "accessory" pour les accessoires (kits, câbles, etc.).
- IMPORTANT — LIGNES SÉPARÉES PAR FILET : si le devis contient plusieurs filets avec des DIMENSIONS DIFFÉRENTES, créer UNE LIGNE PAR FILET (pas une ligne fusionnée). Exemple : Filet n°1 (3,80x7,50m = 28,50 m²) + Filet n°2 (7,50x7,10m = 53,25 m²) → 2 lignes, pas 1. Si les filets sont IDENTIQUES (mêmes dimensions), une seule ligne suffit avec quantity = surface totale.
- LABEL : quand il y a PLUSIEURS filets identiques, le label DOIT commencer par la quantité. Exemple : "10 x Filet de camouflage rectangulaire vert militaire, finition polyester, 3,41 x 1,76 m". Pour un seul filet, pas de préfixe.
- Pour chaque ligne filet (unit="m2") : "quantity" = surface TOTALE en m² (nombre × largeur × hauteur). "unitPrice" = prix par m² tel qu'indiqué dans le texte.
  Exemples :
  - 10 filets IDENTIQUES de 3,41×1,76m → label="10 x Filet...", quantity = 10×3,41×1,76 = 60,02
  - 1 filet 3,80×7,50m + 1 filet 7,50×7,10m → 2 lignes séparées, sans préfixe quantité
- Si la livraison est offerte/gratuite, ajoute une ligne type "transport" et une ligne "transport_discount" avec le même montant en négatif.
- REMISES : si une remise globale est mentionnée (ex: -10%, remise B2B, remise commerciale), NE PAS créer de ligne "remise" dans lines. Mettre le pourcentage dans le champ "discountPercent" du JSON. Les lignes ne doivent contenir QUE les vrais produits/accessoires/transport.
- LABELS MULTILINGUES : pour les produits sur mesure, consulter la TABLE DE CORRESPONDANCE DES NOMS SUR MESURE dans les documents. Assembler le label en combinant type + forme + dimensions + couleur + finition dans la langue de la boutique. NE PAS inventer de traduction, copier les mots EXACTEMENT depuis la table. Pour les accessoires catalogue, utiliser le nom tel qu'il apparaît dans le catalogue de la boutique.
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
      "unitPrice": "prix unitaire HT (pour les accessoires : chercher dans le TABLEAU DES PRIX HT ACCESSOIRES)",
      "unit": "m2 ou piece",
      "description": "UNIQUEMENT pour les filets SUR MESURE : 'Quantité : X | Total m² : Y | Délai de production + livraison : environ 14 jours'. Pour les tailles STANDARD du catalogue, laisser vide ou ne pas inclure ce champ."
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
