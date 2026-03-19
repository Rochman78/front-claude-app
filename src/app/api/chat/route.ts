import { NextRequest } from 'next/server';
import { createChatStream } from '@/lib/services/claudeService';

export async function POST(req: NextRequest) {
  try {
    const { systemPrompt, messages, model, documents } = await req.json();

    if (!process.env.ANTHROPIC_API_KEY) {
      return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY non configurée' }), { status: 500 });
    }

    const { stream } = createChatStream({ systemPrompt, messages, model, documents });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Erreur inconnue';
    console.error('Claude API error:', message);
    return new Response(JSON.stringify({ error: message }), { status: 500 });
  }
}
