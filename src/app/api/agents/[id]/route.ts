import { NextRequest, NextResponse } from 'next/server';
import pool, { initDB } from '@/lib/db';

export const maxDuration = 30;
export const dynamic = 'force-dynamic';
// Augmente la limite body à 10MB pour les fichiers volumineux
export const fetchCache = 'force-no-store';

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
  agent.inboxId = agent.inbox_id;
  delete agent.created_at;
  delete agent.inbox_id;

  return NextResponse.json(agent);
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  await initDB();
  const agent = await req.json();
  const files = agent.files || [];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      'UPDATE agents SET name = $1, email = $2, inbox_id = $3, instructions = $4 WHERE id = $5',
      [agent.name, agent.email, agent.inboxId || '', agent.instructions, params.id]
    );

    await client.query('DELETE FROM agent_files WHERE agent_id = $1', [params.id]);

    for (const file of files) {
      await client.query(
        'INSERT INTO agent_files (id, agent_id, name, content, created_at) VALUES ($1, $2, $3, $4, $5)',
        [file.id, params.id, file.name, file.content, file.createdAt || new Date().toISOString()]
      );
    }

    await client.query('COMMIT');
    return NextResponse.json({ success: true, fileCount: files.length });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('PUT agent error:', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  } finally {
    client.release();
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  await initDB();
  await pool.query('DELETE FROM agents WHERE id = $1', [params.id]);
  return NextResponse.json({ success: true });
}
