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
    delete agent.created_at;
  }

  return NextResponse.json(agents);
}

export async function POST(req: NextRequest) {
  await initDB();
  const { name, email } = await req.json();
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();

  await pool.query(
    'INSERT INTO agents (id, name, email, instructions, created_at) VALUES ($1, $2, $3, $4, $5)',
    [id, name, email, '', createdAt]
  );

  return NextResponse.json({ id, name, email, instructions: '', files: [], createdAt });
}
