import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';

const FRONT_API_URL = 'https://api2.frontapp.com';

export async function GET(req: NextRequest) {
  const conversationId = req.nextUrl.searchParams.get('conversation_id');
  if (!conversationId) {
    return NextResponse.json({ summary: '', quote_ready: false });
  }

  try {
    const resp = await fetch(`${FRONT_API_URL}/conversations/${conversationId}/messages`, {
      headers: {
        Authorization: `Bearer ${process.env.FRONT_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });

    if (!resp.ok) return NextResponse.json({ summary: '', quote_ready: false });

    const data = await resp.json();
    const messages = (data._results || []).slice(0, 5);
    if (!messages.length) return NextResponse.json({ summary: '', quote_ready: false });

    const text = messages.map((m: Record<string, unknown>) => {
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

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const result = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 120,
      messages: [{
        role: 'user',
        content:
          'Analyse cette conversation email et reponds en JSON (sans backticks, juste le JSON) :\n' +
          '{"summary":"resume en 1 phrase courte max 15 mots en francais",' +
          '"quote_ready":true,"quote_ready_reason":"raison courte si false"}\n\n' +
          'quote_ready = true UNIQUEMENT si TOUTES ces conditions sont reunies :\n' +
          '1. Le client demande un devis ou un chiffrage\n' +
          '2. On lui a fait une proposition chiffree (prix, dimensions)\n' +
          '3. Le client a CONFIRME/VALIDE la proposition (accord explicite)\n' +
          '4. On a ses coordonnees (nom + email minimum)\n' +
          'Si une de ces conditions manque, quote_ready = false.\n\n' +
          text,
      }],
    });

    let raw = result.content[0].type === 'text' ? result.content[0].text.trim() : '';
    raw = raw.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim();

    try {
      const parsed = JSON.parse(raw);
      return NextResponse.json({
        summary: parsed.summary || '',
        quote_ready: parsed.quote_ready || false,
        quote_ready_reason: parsed.quote_ready_reason || '',
      });
    } catch {
      return NextResponse.json({ summary: raw, quote_ready: false });
    }
  } catch {
    return NextResponse.json({ summary: '', quote_ready: false });
  }
}
