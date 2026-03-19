import { NextRequest, NextResponse } from 'next/server';

const FRONT_API_URL = 'https://api2.frontapp.com';

export async function GET(req: NextRequest) {
  try {
    if (!process.env.FRONT_API_TOKEN) {
      return NextResponse.json({ error: 'FRONT_API_TOKEN non configuré' }, { status: 500 });
    }

    const conversationId = req.nextUrl.searchParams.get('conversation_id');
    if (!conversationId) {
      return NextResponse.json({ error: 'conversation_id requis' }, { status: 400 });
    }

    const headers = {
      Authorization: `Bearer ${process.env.FRONT_API_TOKEN}`,
      'Content-Type': 'application/json',
    };

    // Try fetching all messages first
    const messagesRes = await fetch(
      `${FRONT_API_URL}/conversations/${conversationId}/messages`,
      { headers }
    );

    if (messagesRes.ok) {
      const data = await messagesRes.json();

      // Also fetch internal comments
      const commentsRes = await fetch(
        `${FRONT_API_URL}/conversations/${conversationId}/comments`,
        { headers }
      );
      if (commentsRes.ok) {
        const commentsData = await commentsRes.json();
        const comments = (commentsData._results || []).map((c: Record<string, unknown>) => ({
          ...c,
          is_comment: true,
          is_inbound: false,
          body: c.body || '',
        }));
        data._results = [...(data._results || []), ...comments];
      }

      return NextResponse.json(data);
    }

    // Fallback: if messages:read scope is missing (403), fetch conversation details
    // which includes last_message and subject
    const convRes = await fetch(
      `${FRONT_API_URL}/conversations/${conversationId}`,
      { headers }
    );

    if (!convRes.ok) {
      const errorText = await convRes.text();
      return NextResponse.json(
        { error: `FrontApp API error: ${convRes.status} - ${errorText}` },
        { status: convRes.status }
      );
    }

    const conv = await convRes.json();

    // Build a synthetic messages list from conversation data
    const messages = [];
    if (conv.last_message) {
      messages.push(conv.last_message);
    }

    return NextResponse.json({
      _results: messages,
      _subject: conv.subject || '',
      _partial: true, // flag to indicate we only have partial data
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Erreur inconnue';
    console.error('FrontApp messages error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
