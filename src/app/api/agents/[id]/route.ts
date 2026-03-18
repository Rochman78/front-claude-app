import { NextRequest, NextResponse } from 'next/server';
import pool, { initDB } from '@/lib/db';

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  await initDB();
  const { rows } = await pool.query('SELECT * FROM agents WHERE id = $1', [params.id]);
  if (rows.length === 0) return NextResponse.json(null, { status: 404 });

  const agent = rows[0];
  const { rows: files } = await pool.query(
    'SELECT id, name, content, created_at AS "createdAt" FROM agent_files WHERE agent_id = $1 ORDER BY created_at',
    [agent.id]
  );
  agent.files = files;
  agent.createdAt = agent.created_at;
  delete agent.created_at;

  return NextResponse.json(agent);
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  await initDB();
  const agent = await req.json();

  await pool.query(
    'UPDATE agents SET name = $1, email = $2, instructions = $3 WHERE id = $4',
    [agent.name, agent.email, agent.instructions, params.id]
  );

  // Sync files: delete all then re-insert
  await pool.query('DELETE FROM agent_files WHERE agent_id = $1', [params.id]);
  for (const file of agent.files || []) {
    await pool.query(
      'INSERT INTO agent_files (id, agent_id, name, content, created_at) VALUES ($1, $2, $3, $4, $5)',
      [file.id, params.id, file.name, file.content, file.createdAt]
    );
  }

  return NextResponse.json({ success: true });
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  await initDB();
  await pool.query('DELETE FROM agents WHERE id = $1', [params.id]);
  return NextResponse.json({ success: true });
}
