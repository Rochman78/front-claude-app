import { NextRequest, NextResponse } from 'next/server';
import pool, { initDB } from '@/lib/db';

/**
 * DELETE /api/plugin/conversation?front_conversation_id=X&store_code=Y
 * Supprime la conversation Claude + messages pour un reset complet.
 */
export async function DELETE(req: NextRequest) {
  try {
    await initDB();
    const frontConvId = req.nextUrl.searchParams.get('front_conversation_id');
    const storeCode = req.nextUrl.searchParams.get('store_code');

    if (!frontConvId || !storeCode) {
      return NextResponse.json({ error: 'front_conversation_id et store_code requis' }, { status: 400 });
    }

    const { rows: agents } = await pool.query('SELECT id FROM agents WHERE store_code = $1 LIMIT 1', [storeCode]);
    if (agents.length === 0) return NextResponse.json({ deleted: 0 });

    const { rows: convRows } = await pool.query(
      'SELECT id FROM claude_conversations WHERE agent_id = $1 AND front_conversation_id = $2',
      [agents[0].id, frontConvId]
    );

    let deletedMsgs = 0;
    let deletedConvs = 0;
    for (const conv of convRows) {
      const r1 = await pool.query('DELETE FROM claude_messages WHERE conversation_id = $1', [conv.id]);
      deletedMsgs += r1.rowCount || 0;
      const r2 = await pool.query('DELETE FROM claude_conversations WHERE id = $1', [conv.id]);
      deletedConvs += r2.rowCount || 0;
    }

    // Nettoyer aussi les caches de résumés et brouillons
    try {
      for (const conv of convRows) {
        await pool.query('DELETE FROM conversation_summaries WHERE conversation_id = $1', [conv.id]);
        await pool.query('DELETE FROM conversation_draft_cache WHERE conversation_id = $1', [conv.id]);
      }
    } catch { /* tables optionnelles */ }

    console.log(`[plugin/conversation] DELETE: ${deletedConvs} conversations, ${deletedMsgs} messages for ${frontConvId}`);
    return NextResponse.json({ deleted: deletedConvs, messages: deletedMsgs });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Erreur inconnue';
    console.error('[plugin/conversation] DELETE error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/**
 * GET /api/plugin/conversation?front_conversation_id=X&store_code=Y
 * Retourne la conversation Claude + messages si elle existe.
 * Retourne null si pas de conversation.
 *
 * Aussi : nettoyage auto des conversations > 24h.
 */
export async function GET(req: NextRequest) {
  try {
    await initDB();

    const frontConvId = req.nextUrl.searchParams.get('front_conversation_id');
    const storeCode = req.nextUrl.searchParams.get('store_code');

    if (!frontConvId || !storeCode) {
      return NextResponse.json({ error: 'front_conversation_id et store_code requis' }, { status: 400 });
    }

    // Nettoyage auto : supprimer les conversations > 24h (non bloquant)
    try {
      const deleted = await pool.query(`
        DELETE FROM claude_messages WHERE conversation_id IN (
          SELECT id FROM claude_conversations WHERE updated_at < NOW() - INTERVAL '24 hours'
        )
      `);
      const deletedConvs = await pool.query(`
        DELETE FROM claude_conversations WHERE updated_at < NOW() - INTERVAL '24 hours'
      `);
      if ((deletedConvs.rowCount || 0) > 0) {
        console.log(`[plugin/conversation] cleanup: ${deletedConvs.rowCount} conversations, ${deleted.rowCount} messages (>24h)`);
      }
    } catch {
      // Non bloquant
    }

    // Trouver l'agent par store_code
    const { rows: agents } = await pool.query(
      'SELECT id FROM agents WHERE store_code = $1 LIMIT 1',
      [storeCode]
    );

    if (agents.length === 0) {
      return NextResponse.json(null);
    }

    const agentId = agents[0].id;

    // Chercher la conversation
    const { rows: convRows } = await pool.query(
      'SELECT * FROM claude_conversations WHERE agent_id = $1 AND front_conversation_id = $2',
      [agentId, frontConvId]
    );

    if (convRows.length === 0) {
      return NextResponse.json(null);
    }

    const conversation = convRows[0];

    // Charger les messages
    const { rows: messages } = await pool.query(
      'SELECT id, role, content, created_at FROM claude_messages WHERE conversation_id = $1 ORDER BY created_at',
      [conversation.id]
    );

    return NextResponse.json({
      conversationId: conversation.id,
      frontConversationId: conversation.front_conversation_id,
      subject: conversation.subject,
      // updated_at = date du dernier brouillon Claude / dernier échange.
      // Utilisé côté plugin pour détecter si un nouveau mail client est
      // arrivé APRÈS notre dernier travail (auto-reset landing).
      updatedAt: conversation.updated_at,
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        createdAt: m.created_at,
      })),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Erreur inconnue';
    console.error('[plugin/conversation] error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
