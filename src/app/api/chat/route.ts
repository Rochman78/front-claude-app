import Anthropic from '@anthropic-ai/sdk';
import { NextRequest, NextResponse } from 'next/server';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export async function POST(req: NextRequest) {
  try {
    const { systemPrompt, messages } = await req.json();

    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json({ error: 'ANTHROPIC_API_KEY non configurée' }, { status: 500 });
    }

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      system: systemPrompt || 'Tu es un assistant IA utile.',
      messages: messages.map((m: { role: string; content: string }) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
    });

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    return NextResponse.json({ content: text });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Erreur inconnue';
    console.error('Claude API error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
