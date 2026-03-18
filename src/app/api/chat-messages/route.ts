import { NextRequest, NextResponse } from 'next/server';
import pool, { initDB } from '@/lib/db';

export async function GET(req: NextRequest) {
  await initDB();
  const key = req.nextUrl.searchParams.get('key');
  if (!key) return NextResponse.json([]);

  const { rows } = await pool.query(
    'SELECT id, role, content, timestamp FROM chat_messages WHERE chat_key = $1 ORDER BY timestamp',
    [key]
  );

  return NextResponse.json(rows);
}

export async function POST(req: NextRequest) {
  await initDB();
  const { key, messages } = await req.json();

  // Replace all messages for this key
  await pool.query('DELETE FROM chat_messages WHERE chat_key = $1', [key]);
  for (const msg of messages) {
    await pool.query(
      'INSERT INTO chat_messages (id, chat_key, role, content, timestamp) VALUES ($1, $2, $3, $4, $5)',
      [msg.id, key, msg.role, msg.content, msg.timestamp]
    );
  }

  return NextResponse.json({ success: true });
}
