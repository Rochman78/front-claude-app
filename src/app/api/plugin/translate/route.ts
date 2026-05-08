import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';

/**
 * POST /api/plugin/translate
 * Détecte la langue du client et traduit le brouillon si nécessaire.
 *
 * Body: {
 *   text: string,           — brouillon à traduire (texte brut)
 *   mailContent: string     — fil de mails pour détecter la langue du client
 *   targetLanguage?: string — code langue ISO 639-1 forcé (skip la détection)
 * }
 *
 * Response: {
 *   translatedText: string,
 *   detectedLanguage: string,
 *   wasTranslated: boolean
 * }
 */
export async function POST(req: NextRequest) {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json({ error: 'ANTHROPIC_API_KEY non configurée' }, { status: 500 });
    }

    const { text, mailContent, targetLanguage, detectOnly } = await req.json();

    if (!detectOnly && (!text || (!mailContent && !targetLanguage))) {
      return NextResponse.json({ error: 'text et (mailContent ou targetLanguage) requis' }, { status: 400 });
    }

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // Étape 1 : détecter la langue du client (ou utiliser la langue forcée)
    let detectedLanguage: string;

    if (targetLanguage) {
      // Langue forcée depuis le store_code → pas de détection
      detectedLanguage = targetLanguage.trim().toLowerCase().substring(0, 2);
      console.log(`[plugin/translate] langue forcée: ${detectedLanguage}`);
    } else {
      const detectResponse = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 50,
        messages: [
          {
            role: 'user',
            content: `Détecte la langue dans laquelle le CLIENT écrit (pas la boutique/service client). Ignore les messages envoyés par la boutique, les signatures, les mentions légales. Cherche le message le plus récent écrit PAR LE CLIENT et identifie sa langue. Réponds UNIQUEMENT avec le code ISO 639-1 (fr, en, de, nl, es, it, pt, etc.).\n\n${mailContent.substring(0, 3000)}`,
          },
        ],
      });
      detectedLanguage = (detectResponse.content[0].type === 'text' ? detectResponse.content[0].text : 'fr').trim().toLowerCase().substring(0, 2);
      console.log(`[plugin/translate] langue détectée: ${detectedLanguage}`);
    }

    // Mode détection uniquement
    if (detectOnly) {
      return NextResponse.json({ detectedLanguage, wasTranslated: false });
    }

    // Si français, pas de traduction
    if (detectedLanguage === 'fr') {
      return NextResponse.json({
        translatedText: text,
        detectedLanguage: 'fr',
        wasTranslated: false,
      });
    }

    // Étape 2 : traduire le brouillon
    const langNames: Record<string, string> = {
      en: 'anglais', de: 'allemand', nl: 'néerlandais', es: 'espagnol',
      it: 'italien', pt: 'portugais', pl: 'polonais', sv: 'suédois',
      da: 'danois', fi: 'finnois', no: 'norvégien', cs: 'tchèque',
      hu: 'hongrois', ro: 'roumain', bg: 'bulgare', hr: 'croate',
      sk: 'slovaque', sl: 'slovène', et: 'estonien', lv: 'letton',
      lt: 'lituanien', el: 'grec',
    };
    const langName = langNames[detectedLanguage] || detectedLanguage;

    const translateResponse = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content: `Traduis ce mail de service client du français vers le ${langName}. Garde exactement le même ton, la même structure et le même formatage. Ne traduis PAS les noms propres (noms de produits, noms de boutique, etc.). Retourne UNIQUEMENT le texte traduit, sans commentaire ni explication.\n\n${text}`,
        },
      ],
    });

    const translatedText = translateResponse.content[0].type === 'text' ? translateResponse.content[0].text : text;
    console.log(`[plugin/translate] traduit fr → ${detectedLanguage} (${translatedText.length} chars)`);

    return NextResponse.json({
      translatedText,
      detectedLanguage,
      wasTranslated: true,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Erreur inconnue';
    console.error('[plugin/translate] error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
