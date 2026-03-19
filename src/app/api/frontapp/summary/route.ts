import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import pool, { initDB } from '@/lib/db';

const FRONT_API_URL = 'https://api2.frontapp.com';
// Durée max du cache : 2h. Si un nouveau message est arrivé depuis, on regénère.
const CACHE_TTL_MS = 2 * 60 * 60 * 1000;

export async function GET(req: NextRequest) {
  const conversationId = req.nextUrl.searchParams.get('conversation_id');
  if (!conversationId) return NextResponse.json({ summary: '', quote_ready: false });

  await initDB();

  // 1. Fetch conversation messages from Front (needed to check last_message_ts)
  const frontResp = await fetch(
    `${FRONT_API_URL}/conversations/${conversationId}/messages`,
    { headers: { Authorization: `Bearer ${process.env.FRONT_API_TOKEN}`, 'Content-Type': 'application/json' } }
  ).catch(() => null);

  if (!frontResp?.ok) return NextResponse.json({ summary: '', quote_ready: false });

  const data = await frontResp.json();
  const messages = (data._results || []).filter((m: Record<string, unknown>) => !m.is_draft);
  if (!messages.length) return NextResponse.json({ summary: '', quote_ready: false });

  // Last message timestamp (most recent)
  const lastMsgTs: number = Math.max(...messages.map((m: Record<string, unknown>) => Number(m.created_at) || 0));

  // 2. Check cache
  const { rows } = await pool.query(
    'SELECT * FROM conversation_summaries WHERE conversation_id = $1',
    [conversationId]
  );

  if (rows.length > 0) {
    const cached = rows[0];
    const cacheAge = Date.now() - new Date(cached.cached_at).getTime();
    // Use cache if: last message hasn't changed AND cache is fresh
    if (Number(cached.last_message_ts) >= lastMsgTs && cacheAge < CACHE_TTL_MS) {
      return NextResponse.json({
        summary: cached.summary,
        quote_ready: cached.quote_ready,
        quote_ready_reason: cached.quote_ready_reason,
        cached: true,
      });
    }
  }

  // 3. Generate with Claude Haiku
  const text = messages.slice(0, 5).map((m: Record<string, unknown>) => {
    const author = m.author
      ? `${(m.author as Record<string, string>).first_name || ''} ${(m.author as Record<string, string>).last_name || ''}`.trim()
      : '';
    const body = ((m.body as string) || '')
      .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300);
    return `${author}: ${body}`;
  }).join('\n');

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const result = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 120,
      messages: [{
        role: 'user',
        content:
          'Analyse cette conversation email et reponds en JSON (sans backticks, juste le JSON) :\n' +
          '{"summary":"resume en 1 phrase courte max 15 mots en francais",' +
          '"quote_ready":false,"quote_ready_reason":"raison courte si false"}\n\n' +
          'quote_ready = true UNIQUEMENT si TOUTES ces conditions sont reunies :\n' +
          '1. Le client demande un devis ou un chiffrage\n' +
          '2. On lui a fait une proposition chiffree (prix, dimensions)\n' +
          '3. Le client a CONFIRME/VALIDE la proposition (accord explicite)\n' +
          '4. On a ses coordonnees (nom + email minimum)\n' +
          'Si une de ces conditions manque, quote_ready = false.\n\n' + text,
      }],
    });

    let raw = result.content[0].type === 'text' ? result.content[0].text.trim() : '';
    raw = raw.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim();

    let summary = '', quote_ready = false, quote_ready_reason = '';
    try {
      const parsed = JSON.parse(raw);
      summary = parsed.summary || '';
      quote_ready = parsed.quote_ready || false;
      quote_ready_reason = parsed.quote_ready_reason || '';
    } catch {
      summary = raw;
    }

    // 4. Store in cache (upsert)
    await pool.query(
      `INSERT INTO conversation_summaries (conversation_id, summary, quote_ready, quote_ready_reason, last_message_ts, cached_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (conversation_id) DO UPDATE SET
         summary = EXCLUDED.summary,
         quote_ready = EXCLUDED.quote_ready,
         quote_ready_reason = EXCLUDED.quote_ready_reason,
         last_message_ts = EXCLUDED.last_message_ts,
         cached_at = EXCLUDED.cached_at`,
      [conversationId, summary, quote_ready, quote_ready_reason, lastMsgTs, new Date().toISOString()]
    );

    return NextResponse.json({ summary, quote_ready, quote_ready_reason, cached: false });
  } catch {
    return NextResponse.json({ summary: '', quote_ready: false });
  }
}
