import { NextRequest, NextResponse } from 'next/server';
import pool, { initDB } from '@/lib/db';

export async function GET() {
  await initDB();
  const { rows: agents } = await pool.query('SELECT * FROM agents ORDER BY created_at DESC');

  for (const agent of agents) {
    const { rows: files } = await pool.query(
      'SELECT id, name, content, created_at AS "createdAt" FROM agent_files WHERE agent_id = $1 ORDER BY created_at',
      [agent.id]
    );
    agent.files = files;
    agent.createdAt = agent.created_at;
    agent.inboxId = agent.inbox_id;
    delete agent.created_at;
    delete agent.inbox_id;
  }

  return NextResponse.json(agents);
}

export async function POST(req: NextRequest) {
  await initDB();
  const { name, email, inboxId } = await req.json();
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();

  await pool.query(
    'INSERT INTO agents (id, name, email, inbox_id, instructions, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
    [id, name, email, inboxId || '', '', createdAt]
  );

  return NextResponse.json({ id, name, email, inboxId: inboxId || '', instructions: '', files: [], createdAt });
}
