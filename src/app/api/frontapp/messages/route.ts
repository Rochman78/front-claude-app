import { NextRequest, NextResponse } from 'next/server';
import { getConversationMessages } from '@/lib/services/frontappService';

export async function GET(req: NextRequest) {
  try {
    if (!process.env.FRONT_API_TOKEN) {
      return NextResponse.json({ error: 'FRONT_API_TOKEN non configuré' }, { status: 500 });
    }

    const conversationId = req.nextUrl.searchParams.get('conversation_id');
    if (!conversationId) {
      return NextResponse.json({ error: 'conversation_id requis' }, { status: 400 });
    }

    const { messages, subject, partial } = await getConversationMessages(conversationId);

    return NextResponse.json({
      _results: messages,
      _subject: subject,
      _partial: partial,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Erreur inconnue';
    console.error('FrontApp messages error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
