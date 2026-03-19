import Anthropic from '@anthropic-ai/sdk';
import { NextRequest } from 'next/server';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export async function POST(req: NextRequest) {
  try {
    const { systemPrompt, messages, model: requestedModel, documents } = await req.json();

    if (!process.env.ANTHROPIC_API_KEY) {
      return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY non configurée' }), { status: 500 });
    }

    // Sonnet pour brouillon initial (suit les instructions complexes), Haiku pour chat
    const model = requestedModel === 'sonnet' ? 'claude-sonnet-4-6' : 'claude-haiku-4-5-20251001';
    const trimmedMessages = messages.slice(-10);

    // Injecter les documents de référence en prefix (user + assistant ack)
    const docPrefix: { role: 'user' | 'assistant'; content: string }[] = documents
      ? [
          { role: 'user', content: `DOCUMENTS DE RÉFÉRENCE (à consulter pour répondre au client) :\n\n${documents}` },
          { role: 'assistant', content: 'Bien noté. Je dispose des documents de référence et je suis prêt à analyser le mail du client selon le workflow en 3 étapes.' },
        ]
      : [];

    const allMessages = [
      ...docPrefix,
      ...trimmedMessages.map((m: { role: string; content: string }) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
    ];

    const promptSize = (systemPrompt || '').length + allMessages.reduce((n: number, m: { content: string }) => n + m.content.length, 0);
    console.log(`[chat] model=${model} prompt=${promptSize} chars (docs=${documents ? 'yes' : 'no'})`);
    const t0 = Date.now();

    const stream = await anthropic.messages.stream({
      model,
      max_tokens: 4096,
      system: systemPrompt || 'Tu es un assistant IA utile.',
      messages: allMessages,
    });

    const encoder = new TextEncoder();
    const readable = new ReadableStream({
      async start(controller) {
        try {
          let firstChunk = true;
          for await (const chunk of stream) {
            if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
              if (firstChunk) { console.log(`[chat] first token in ${Date.now() - t0}ms`); firstChunk = false; }
              controller.enqueue(encoder.encode(chunk.delta.text));
            }
          }
          console.log(`[chat] done in ${Date.now() - t0}ms`);
        } catch (streamErr) {
          const msg = streamErr instanceof Error ? streamErr.message : 'Erreur stream';
          console.error('Stream error:', msg);
          controller.enqueue(encoder.encode(`__ERROR__${msg}`));
        } finally {
          controller.close();
        }
      },
    });

    return new Response(readable, {
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
