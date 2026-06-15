import { NextRequest, NextResponse } from 'next/server';
import pool, { initDB } from '@/lib/db';
import { getStoreByCode } from '@/lib/stores';

const TEMPLATE_ID = 'tpl_virement_recu';

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

    // 4. PAS de traduction ici — le brouillon affiché dans le plugin reste
    //    en FR (langue de travail du gérant), exactement comme un brouillon
    //    Claude classique. La traduction se fait au MOMENT DU PUSH dans Front
    //    via le mécanisme habituel `pushDraft.handlePush(...)` qui appelle
    //    /api/plugin/translate avec `targetLanguage = store.defaultLang`.
    //    Cohérent avec le flow Analyser → DraftFinal → Push (Charles 15/06/2026).
    const store = getStoreByCode(storeCode);
    const targetLang = store?.defaultLang || 'fr';
    const finalText = interpolated;

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
