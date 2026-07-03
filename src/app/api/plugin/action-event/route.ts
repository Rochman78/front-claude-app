import { NextRequest, NextResponse } from 'next/server';
import pool, { initDB } from '@/lib/db';

/**
 * POST /api/plugin/action-event
 * Log une action effectuée par un gérant depuis le plugin, associée à une
 * conversation Front. Utilisé par la timeline "Voir l'historique interne"
 * pour tracer QUI a fait QUOI (push, validation brouillon, création devis,
 * virement vérifié…).
 *
 * Body: {
 *   frontConversationId: string,
 *   storeCode?: string,
 *   actionType: 'push' | 'draft-validated' | 'quote-created' | 'payment-check' | string,
 *   teammateName?: string,   — from Front SDK context.teammate.name
 *   teammateEmail?: string,  — from Front SDK context.teammate.email (optionnel)
 *   metadata?: Record<string, unknown>,  — action-specific (quote_number, amount, lang, etc.)
 * }
 *
 * Non-bloquant côté client : si l'insert échoue, on ignore.
 */
export async function POST(req: NextRequest) {
  try {
    await initDB();
    // Table auto-créée si absente. Idempotent, safe à runner à chaque call.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS plugin_action_events (
        id UUID PRIMARY KEY,
        front_conversation_id TEXT NOT NULL,
        store_code TEXT,
        action_type TEXT NOT NULL,
        teammate_name TEXT,
        teammate_email TEXT,
        metadata JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_plugin_action_events_conv
        ON plugin_action_events (front_conversation_id, created_at);
    `);

    const {
      frontConversationId,
      storeCode,
      actionType,
      teammateName,
      teammateEmail,
      metadata,
    } = await req.json();

    if (!frontConversationId || !actionType) {
      return NextResponse.json({ error: 'frontConversationId et actionType requis' }, { status: 400 });
    }

    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO plugin_action_events
        (id, front_conversation_id, store_code, action_type, teammate_name, teammate_email, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        id,
        frontConversationId,
        storeCode || null,
        actionType,
        teammateName || null,
        teammateEmail || null,
        metadata ? JSON.stringify(metadata) : null,
      ]
    );

    return NextResponse.json({ id });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Erreur inconnue';
    console.error('[plugin/action-event] POST error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/**
 * GET /api/plugin/action-events?front_conversation_id=X
 * Retourne la liste des events pour cette conv, ordre chronologique.
 */
export async function GET(req: NextRequest) {
  try {
    await initDB();
    const frontConvId = req.nextUrl.searchParams.get('front_conversation_id');
    if (!frontConvId) {
      return NextResponse.json({ events: [] });
    }
    // Auto-création table si absente (au cas où le GET arrive avant le
    // premier POST).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS plugin_action_events (
        id UUID PRIMARY KEY,
        front_conversation_id TEXT NOT NULL,
        store_code TEXT,
        action_type TEXT NOT NULL,
        teammate_name TEXT,
        teammate_email TEXT,
        metadata JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    const { rows } = await pool.query(
      `SELECT id, action_type, teammate_name, teammate_email, metadata, created_at
       FROM plugin_action_events
       WHERE front_conversation_id = $1
       ORDER BY created_at ASC`,
      [frontConvId]
    );
    return NextResponse.json({
      events: rows.map((r) => ({
        id: r.id,
        actionType: r.action_type,
        teammateName: r.teammate_name,
        teammateEmail: r.teammate_email,
        metadata: r.metadata,
        createdAt: r.created_at,
      })),
    });
  } catch (err) {
    console.error('[plugin/action-event] GET error:', err);
    return NextResponse.json({ events: [] });
  }
}
