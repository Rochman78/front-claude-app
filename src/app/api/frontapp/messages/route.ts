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

    const response = await fetch(
      `${FRONT_API_URL}/conversations/${conversationId}/messages`,
      {
        headers: {
          Authorization: `Bearer ${process.env.FRONT_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      return NextResponse.json(
        { error: `FrontApp API error: ${response.status} - ${errorText}` },
        { status: response.status }
      );
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Erreur inconnue';
    console.error('FrontApp messages error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
