import { NextRequest, NextResponse } from 'next/server';
import pool, { initDB } from '@/lib/db';
import { getStoreByCode } from '@/lib/stores';

const TEMPLATE_ID = 'tpl_virement_recu';

interface PostBody {
  frontConversationId: string;
  storeCode: string;
  transactionId: string;
  transactionLabel?: string;
  transactionAmount?: string;
  customerFirstName?: string;
}

/**
 * POST /api/plugin/payment-confirmed
 *
 * Enregistre la confirmation d'un virement reçu (rapprochement manuel par
 * un collaborateur via le panel "Vérifier virement reçu") et pousse un
 * brouillon de confirmation au client dans Front App.
 *
 * - Idempotent : si (front_conversation_id, transaction_id) existe déjà,
 *   on renvoie status="already_confirmed" sans repush.
 * - Multi-langue : le template stocké est en FR ; on traduit via
 *   /api/plugin/translate selon la langue par défaut du store.
 */
export async function POST(req: NextRequest) {
  try {
    await initDB();
    const body: PostBody = await req.json();
    const {
      frontConversationId,
      storeCode,
      transactionId,
      transactionLabel = '',
      transactionAmount = '',
      customerFirstName = '',
    } = body;

    if (!frontConversationId || !storeCode || !transactionId) {
      return NextResponse.json(
        { error: 'frontConversationId, storeCode et transactionId requis' },
        { status: 400 }
      );
    }

    // 1. Idempotence
    const { rows: existing } = await pool.query(
      'SELECT id, confirmed_at FROM payment_confirmations WHERE front_conversation_id = $1 AND transaction_id = $2',
      [frontConversationId, transactionId]
    );
    if (existing.length > 0) {
      console.log(`[payment-confirmed] already confirmed: conv=${frontConversationId} tx=${transactionId}`);
      return NextResponse.json({
        status: 'already_confirmed',
        confirmedAt: existing[0].confirmed_at,
      });
    }

    // 2. Devis associé
    const { rows: quoteRows } = await pool.query(
      'SELECT quote_number FROM conversation_quotes WHERE front_conversation_id = $1 AND store_code = $2',
      [frontConversationId, storeCode]
    );
    if (quoteRows.length === 0) {
      return NextResponse.json({ error: 'Aucun devis trouvé pour cette conversation' }, { status: 404 });
    }
    const quoteNumber = quoteRows[0].quote_number;

    // 3. Template FR
    const { rows: tplRows } = await pool.query(
      'SELECT content FROM templates WHERE id = $1',
      [TEMPLATE_ID]
    );
    if (tplRows.length === 0) {
      return NextResponse.json({ error: `Template ${TEMPLATE_ID} introuvable en BDD` }, { status: 500 });
    }
    const templateFr: string = tplRows[0].content;

    // 4. Interpolation [PRENOM] / [NUM_DEVIS]
    const firstName = (customerFirstName || '').trim() || 'Bonjour';
    let interpolated = templateFr
      .replace(/\[PRENOM\]/g, firstName && firstName !== 'Bonjour' ? firstName : '')
      .replace(/\[NUM_DEVIS\]/g, quoteNumber);
    // Nettoyer "Bonjour ," si pas de prénom
    interpolated = interpolated.replace(/^Bonjour\s*,/m, 'Bonjour,');

    // 5. Traduction si langue du store ≠ FR
    const store = getStoreByCode(storeCode);
    const targetLang = store?.defaultLang || 'fr';
    let finalText = interpolated;

    if (targetLang !== 'fr') {
      try {
        const trRes = await fetch(`${req.nextUrl.origin}/api/plugin/translate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: interpolated, targetLanguage: targetLang }),
        });
        if (trRes.ok) {
          const tr = await trRes.json();
          if (tr.translatedText) finalText = tr.translatedText;
          console.log(`[payment-confirmed] traduit fr→${targetLang} (${interpolated.length}→${finalText.length} chars)`);
        } else {
          console.warn(`[payment-confirmed] /translate ${trRes.status} — fallback FR`);
        }
      } catch (err) {
        console.warn('[payment-confirmed] /translate erreur, fallback FR:', err);
      }
    }

    // 6. Push brouillon dans Front
    let pushSuccess = false;
    let pushError: string | null = null;
    try {
      const pushRes = await fetch(`${req.nextUrl.origin}/api/plugin/push-draft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: frontConversationId,
          body: finalText.replace(/\n/g, '<br>'),
        }),
      });
      pushSuccess = pushRes.ok;
      if (!pushRes.ok) {
        pushError = `push-draft ${pushRes.status}`;
        console.error(`[payment-confirmed] push-draft failed: ${pushError}`);
      }
    } catch (err) {
      pushError = err instanceof Error ? err.message : 'erreur push-draft';
      console.error('[payment-confirmed] push-draft exception:', pushError);
    }

    // 7. Log BDD (anti-double envoi) — on l'enregistre même si push KO
    //    pour ne pas re-pousser à l'identique au prochain clic.
    const confId = crypto.randomUUID();
    const now = new Date().toISOString();
    await pool.query(
      `INSERT INTO payment_confirmations
        (id, front_conversation_id, store_code, quote_number, transaction_id, transaction_label, amount, confirmed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        confId,
        frontConversationId,
        storeCode,
        quoteNumber,
        transactionId,
        transactionLabel,
        transactionAmount,
        now,
      ]
    );
    console.log(`[payment-confirmed] OK conv=${frontConversationId} quote=${quoteNumber} tx=${transactionId} push=${pushSuccess}`);

    return NextResponse.json({
      status: 'confirmed',
      pushSuccess,
      pushError,
      confirmedAt: now,
      draftPreview: finalText,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'erreur inconnue';
    console.error('[payment-confirmed] error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
