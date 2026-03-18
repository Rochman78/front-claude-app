import { NextRequest, NextResponse } from 'next/server';
import pool, { initDB } from '@/lib/db';

export async function GET(req: NextRequest) {
  await initDB();
  const agentId = req.nextUrl.searchParams.get('agentId');

  let rows;
  if (agentId) {
    const result = await pool.query('SELECT * FROM shared_files ORDER BY created_at DESC');
    rows = result.rows.filter((f) => {
      if (f.assigned_to === 'all') return true;
      try {
        const ids = JSON.parse(f.assigned_to);
        return Array.isArray(ids) && ids.includes(agentId);
      } catch {
        return false;
      }
    });
  } else {
    const result = await pool.query('SELECT * FROM shared_files ORDER BY created_at DESC');
    rows = result.rows;
  }

  const files = rows.map((f) => ({
    id: f.id,
    name: f.name,
    content: f.content,
    assignedTo: f.assigned_to === 'all' ? 'all' : JSON.parse(f.assigned_to),
    createdAt: f.created_at,
  }));

  return NextResponse.json(files);
}

export async function POST(req: NextRequest) {
  await initDB();
  const file = await req.json();
  const assignedTo = file.assignedTo === 'all' ? 'all' : JSON.stringify(file.assignedTo);

  await pool.query(
    'INSERT INTO shared_files (id, name, content, assigned_to, created_at) VALUES ($1, $2, $3, $4, $5)',
    [file.id, file.name, file.content, assignedTo, file.createdAt]
  );

  return NextResponse.json({ success: true });
}

export async function DELETE(req: NextRequest) {
  await initDB();
  const { id } = await req.json();
  await pool.query('DELETE FROM shared_files WHERE id = $1', [id]);
  return NextResponse.json({ success: true });
}
