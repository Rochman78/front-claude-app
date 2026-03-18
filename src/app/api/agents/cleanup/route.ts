import { NextResponse } from 'next/server';
import pool, { initDB } from '@/lib/db';

export async function POST() {
  await initDB();

  // Find duplicate agents by inbox_id, keep only the oldest one
  const { rows: duplicates } = await pool.query(`
    DELETE FROM agents
    WHERE id NOT IN (
      SELECT DISTINCT ON (inbox_id) id
      FROM agents
      ORDER BY inbox_id, created_at ASC
    )
    RETURNING id, name, email
  `);

  return NextResponse.json({
    message: `${duplicates.length} agent(s) en doublon supprimé(s)`,
    deleted: duplicates,
  });
}
