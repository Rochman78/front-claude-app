import { NextRequest, NextResponse } from 'next/server';
import { resolveChannelId, resolveAuthorId, createDraft } from '@/lib/services/frontappService';

export async function POST(req: NextRequest) {
  try {
    if (!process.env.FRONT_API_TOKEN) {
      return NextResponse.json({ error: 'FRONT_API_TOKEN non configuré' }, { status: 500 });
    }

    const { conversationId, body } = await req.json();
    if (!conversationId || !body) {
      return NextResponse.json({ error: 'conversationId et body requis' }, { status: 400 });
    }

    const channelId = await resolveChannelId(conversationId);
    const authorId = await resolveAuthorId(conversationId);
    const data = await createDraft(conversationId, body, channelId, authorId);

    return NextResponse.json(data);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Erreur inconnue';
    console.error('FrontApp send error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
