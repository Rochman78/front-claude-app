import { NextRequest, NextResponse } from 'next/server';
import pool, { initDB } from '@/lib/db';

const FRONT_API_URL = 'https://api2.frontapp.com';
// Cache 10 minutes — draft status changes more often than summaries
const CACHE_TTL_MS = 10 * 60 * 1000;

export async function GET(req: NextRequest) {
  const conversationId = req.nextUrl.searchParams.get('conversation_id');
  if (!conversationId) return NextResponse.json({ has_draft: false });

  await initDB();

  // Check cache first
  const { rows } = await pool.query(
    'SELECT * FROM conversation_draft_cache WHERE conversation_id = $1',
    [conversationId]
  );

  if (rows.length > 0) {
    const cached = rows[0];
    const cacheAge = Date.now() - new Date(cached.cached_at).getTime();
    if (cacheAge < CACHE_TTL_MS) {
      return NextResponse.json({ has_draft: cached.has_draft, cached: true });
    }
  }

  try {
    const resp = await fetch(`${FRONT_API_URL}/conversations/${conversationId}/drafts`, {
      headers: {
        Authorization: `Bearer ${process.env.FRONT_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });

    if (!resp.ok) return NextResponse.json({ has_draft: false });

    const data = await resp.json();
    const drafts = (data._results || []) as Record<string, unknown>[];
    const has_draft = drafts.filter((d) => d.draft_mode === 'shared').length > 0;

    // Upsert into cache
    await pool.query(
      `INSERT INTO conversation_draft_cache (conversation_id, has_draft, cached_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (conversation_id) DO UPDATE SET
         has_draft = EXCLUDED.has_draft,
         cached_at = EXCLUDED.cached_at`,
      [conversationId, has_draft, new Date().toISOString()]
    );

    return NextResponse.json({ has_draft, cached: false });
  } catch {
    return NextResponse.json({ has_draft: false });
  }
}
