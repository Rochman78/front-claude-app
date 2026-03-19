import { NextRequest, NextResponse } from 'next/server';
import pool, { initDB } from '@/lib/db';

/**
 * GET /api/conversations?agent_id=X&front_conversation_id=Y
 * Récupère ou crée une conversation Claude liée à un thread FrontApp.
 * Retourne la conversation avec tout son historique de messages.
 */
export async function GET(req: NextRequest) {
  await initDB();
  const agentId = req.nextUrl.searchParams.get('agent_id');
  const frontConvId = req.nextUrl.searchParams.get('front_conversation_id');
  const subject = req.nextUrl.searchParams.get('subject') || '';

  if (!agentId || !frontConvId) {
    return NextResponse.json({ error: 'agent_id et front_conversation_id requis' }, { status: 400 });
  }

  // Chercher une conversation existante
  const { rows } = await pool.query(
    'SELECT * FROM claude_conversations WHERE agent_id = $1 AND front_conversation_id = $2',
    [agentId, frontConvId]
  );

  let conversation = rows[0];

  // Créer si inexistante
  if (!conversation) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await pool.query(
      'INSERT INTO claude_conversations (id, agent_id, front_conversation_id, subject, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [id, agentId, frontConvId, subject, now, now]
    );
    conversation = { id, agent_id: agentId, front_conversation_id: frontConvId, subject, status: 'open', created_at: now, updated_at: now };
  }

  // Charger les messages
  const messages = await pool.query(
    'SELECT id, role, content, created_at FROM claude_messages WHERE conversation_id = $1 ORDER BY created_at',
    [conversation.id]
  );

  return NextResponse.json({
    ...conversation,
    messages: messages.rows,
  });
}

/**
 * POST /api/conversations
 * Ajoute un message à une conversation Claude existante.
 * Body: { conversation_id, role, content }
 */
export async function POST(req: NextRequest) {
  await initDB();
  const { conversation_id, role, content } = await req.json();

  if (!conversation_id || !role || !content) {
    return NextResponse.json({ error: 'conversation_id, role et content requis' }, { status: 400 });
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await pool.query(
    'INSERT INTO claude_messages (id, conversation_id, role, content, created_at) VALUES ($1, $2, $3, $4, $5)',
    [id, conversation_id, role, content, now]
  );

  // Mettre à jour le timestamp de la conversation
  await pool.query(
    'UPDATE claude_conversations SET updated_at = $1 WHERE id = $2',
    [now, conversation_id]
  );

  return NextResponse.json({ id, role, content, created_at: now });
}

/**
 * DELETE /api/conversations
 * Supprime tous les messages d'une conversation (reset).
 * Body: { conversation_id }
 */
export async function DELETE(req: NextRequest) {
  await initDB();
  const { conversation_id } = await req.json();

  if (!conversation_id) {
    return NextResponse.json({ error: 'conversation_id requis' }, { status: 400 });
  }

  await pool.query('DELETE FROM claude_messages WHERE conversation_id = $1', [conversation_id]);

  return NextResponse.json({ success: true });
}
