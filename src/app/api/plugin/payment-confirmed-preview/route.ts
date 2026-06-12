import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import pool, { initDB } from '@/lib/db';
import { getStoreByCode } from '@/lib/stores';

const TEMPLATE_ID = 'tpl_virement_recu';

const LANG_NAMES: Record<string, string> = {
  en: 'anglais', de: 'allemand', nl: 'néerlandais', es: 'espagnol',
  it: 'italien', pt: 'portugais',
};

interface PostBody {
  frontConversationId: string;
  storeCode: string;
  customerFirstName?: string;
  /** N° de devis fourni par le collab — prévaut sur celui de la BDD. Permet
   *  de gérer les devis créés hors plugin (Pennylane direct, ancienne Flask,
   *  etc.) qui n'ont pas d'entrée dans conversation_quotes. */
  quoteNumber?: string;
}

/**
 * POST /api/plugin/payment-confirmed-preview
 *
 * Prépare le texte du brouillon "virement reçu" (interpolation +
 * traduction selon la langue du store) et le RETOURNE au client SANS
 * push dans Front et SANS log BDD.
 *
 * Côté UI : ce texte est ensuite injecté dans le bloc DraftFinal du
 * plugin pour que le collab valide / édite / pousse via le flow
 * habituel.
 */
export async function POST(req: NextRequest) {
  try {
    await initDB();
    const { frontConversationId, storeCode, customerFirstName = '', quoteNumber: customQuoteNumber }: PostBody = await req.json();

    if (!frontConversationId || !storeCode) {
      return NextResponse.json(
        { error: 'frontConversationId et storeCode requis' },
        { status: 400 }
      );
    }

    // 1. Numéro de devis : custom (saisi par le collab) prévaut, sinon BDD.
    let quoteNumber = (customQuoteNumber || '').trim();
    if (!quoteNumber) {
      const { rows: quoteRows } = await pool.query(
        'SELECT quote_number FROM conversation_quotes WHERE front_conversation_id = $1 AND store_code = $2',
        [frontConversationId, storeCode]
      );
      quoteNumber = quoteRows[0]?.quote_number || '';
    }
    if (!quoteNumber) {
      return NextResponse.json({
        error: 'Aucun n° de devis fourni ni associé à la conversation. Saisis le numéro dans le panel.',
      }, { status: 400 });
    }

    // 2. Template FR
    const { rows: tplRows } = await pool.query(
      'SELECT content FROM templates WHERE id = $1',
      [TEMPLATE_ID]
    );
    if (tplRows.length === 0) {
      return NextResponse.json({ error: `Template ${TEMPLATE_ID} introuvable en BDD` }, { status: 500 });
    }
    const templateFr: string = tplRows[0].content;

    // 3. Interpolation [PRENOM] / [NUM_DEVIS]
    const firstName = (customerFirstName || '').trim();
    let interpolated = templateFr
      .replace(/\[PRENOM\]/g, firstName)
      .replace(/\[NUM_DEVIS\]/g, quoteNumber);
    // Nettoyer "Bonjour ," si pas de prénom
    interpolated = interpolated.replace(/^Bonjour\s*,/m, 'Bonjour,');

    // 4. Traduction si langue du store ≠ FR — appel DIRECT à Anthropic
    const store = getStoreByCode(storeCode);
    const targetLang = store?.defaultLang || 'fr';
    let finalText = interpolated;

    if (targetLang !== 'fr') {
      if (!process.env.ANTHROPIC_API_KEY) {
        console.warn('[payment-confirmed-preview] ANTHROPIC_API_KEY absent → fallback FR');
      } else {
        try {
          const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
          const langName = LANG_NAMES[targetLang] || targetLang;
          const t0 = Date.now();
          const tr = await client.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 1024,
            messages: [
              {
                role: 'user',
                content: `Traduis ce mail de service client du français vers le ${langName}. Garde exactement le même ton, la même structure et le même formatage.\n\nTraduis TOUT le contenu. Ne laisse AUCUNE phrase en français.\n\nGarde uniquement tels quels (NE traduis PAS) : les références/codes produit (ex : « D-2026-… »), les noms propres, les nombres et symboles.\n\nN'AJOUTE PAS de formule de politesse finale (« Cordialement », « Bien à vous », équivalents dans la langue cible). La signature est gérée séparément par le mail.\n\nRetourne UNIQUEMENT le texte traduit, sans commentaire ni explication.\n\n${interpolated}`,
              },
            ],
          });
          const block = tr.content[0];
          if (block && block.type === 'text' && block.text.trim()) {
            finalText = block.text;
            console.log(`[payment-confirmed-preview] traduit fr→${targetLang} (${interpolated.length}→${finalText.length} chars, ${Date.now() - t0}ms)`);
          } else {
            console.warn('[payment-confirmed-preview] traduction vide → fallback FR');
          }
        } catch (err) {
          console.warn('[payment-confirmed-preview] Anthropic translate erreur, fallback FR:', err);
        }
      }
    }

    return NextResponse.json({
      text: finalText,
      quoteNumber,
      targetLang,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'erreur inconnue';
    console.error('[payment-confirmed-preview] error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
