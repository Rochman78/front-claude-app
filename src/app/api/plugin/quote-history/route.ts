import { NextRequest, NextResponse } from 'next/server';
import pool, { initDB } from '@/lib/db';

/**
 * GET /api/plugin/quote-history?front_conversation_id=X&store_code=Y
 * Retourne le devis créé pour cette conversation (s'il existe).
 */
export async function GET(req: NextRequest) {
  try {
    await initDB();
    const frontConvId = req.nextUrl.searchParams.get('front_conversation_id');
    const storeCode = req.nextUrl.searchParams.get('store_code');
    if (!frontConvId || !storeCode) {
      return NextResponse.json(null);
    }

    const { rows } = await pool.query(
      'SELECT quote_number, pennylane_url, pdf_url, amount, created_at FROM conversation_quotes WHERE front_conversation_id = $1 AND store_code = $2',
      [frontConvId, storeCode]
    );

    if (rows.length === 0) return NextResponse.json(null);
    return NextResponse.json(rows[0]);
  } catch (err) {
    console.error('[quote-history] GET error:', err);
    return NextResponse.json(null);
  }
}

/**
 * POST /api/plugin/quote-history
 * Sauvegarde l'info d'un devis créé pour une conversation.
 */
export async function POST(req: NextRequest) {
  try {
    await initDB();
    const { frontConversationId, storeCode, quoteNumber, pennylaneUrl, pdfUrl, amount } = await req.json();

    if (!frontConversationId || !storeCode || !quoteNumber) {
      return NextResponse.json({ error: 'Champs requis manquants' }, { status: 400 });
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    await pool.query(
      `INSERT INTO conversation_quotes (id, front_conversation_id, store_code, quote_number, pennylane_url, pdf_url, amount, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (front_conversation_id, store_code) DO UPDATE SET
         quote_number = $4, pennylane_url = $5, pdf_url = $6, amount = $7, created_at = $8`,
      [id, frontConversationId, storeCode, quoteNumber, pennylaneUrl || '', pdfUrl || '', amount || '', now]
    );

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[quote-history] POST error:', err);
    return NextResponse.json({ error: 'Erreur sauvegarde' }, { status: 500 });
  }
}
