import { NextRequest, NextResponse } from 'next/server';

const FRONT_API_URL = 'https://api2.frontapp.com';

export async function POST(req: NextRequest) {
  try {
    if (!process.env.FRONT_API_TOKEN) {
      return NextResponse.json({ error: 'FRONT_API_TOKEN non configuré' }, { status: 500 });
    }

    const { conversationId, body, to } = await req.json();

    if (!conversationId || !body) {
      return NextResponse.json({ error: 'conversationId et body requis' }, { status: 400 });
    }

    // Send reply to a conversation
    const response = await fetch(
      `${FRONT_API_URL}/conversations/${conversationId}/drafts`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.FRONT_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          author_id: 'ALT:email:' + (to || 'default@company.com'),
          body,
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      return NextResponse.json(
        { error: `FrontApp API error: ${response.status} - ${errorText}` },
        { status: response.status }
      );
    }

    // 201 Created for drafts, may have no body
    const text = await response.text();
    const data = text ? JSON.parse(text) : { success: true };
    return NextResponse.json(data);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Erreur inconnue';
    console.error('FrontApp send error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
