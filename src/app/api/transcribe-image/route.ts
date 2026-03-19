import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const { imageBase64 } = await req.json();
  if (!imageBase64) return NextResponse.json({ text: '' });

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const result = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 },
          },
          {
            type: 'text',
            text: 'Transcris intégralement tout le contenu textuel de cette image. Préserve la structure (tableaux, listes, titres). Retourne uniquement le texte extrait, sans commentaire ni introduction.',
          },
        ],
      }],
    });
    const text = result.content[0].type === 'text' ? result.content[0].text : '';
    return NextResponse.json({ text });
  } catch (err) {
    console.error('transcribe-image error:', err);
    return NextResponse.json({ text: '', error: String(err) }, { status: 500 });
  }
}
