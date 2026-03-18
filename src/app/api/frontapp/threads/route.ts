import { NextRequest, NextResponse } from 'next/server';

const FRONT_API_URL = 'https://api2.frontapp.com';

export async function GET(req: NextRequest) {
  try {
    if (!process.env.FRONT_API_TOKEN) {
      return NextResponse.json({ error: 'FRONT_API_TOKEN non configuré' }, { status: 500 });
    }

    const inboxId = req.nextUrl.searchParams.get('inbox_id');

    // If inbox_id provided, fetch conversations for that inbox
    const url = inboxId
      ? `${FRONT_API_URL}/inboxes/${inboxId}/conversations`
      : `${FRONT_API_URL}/conversations`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${process.env.FRONT_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });

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
    console.error('FrontApp threads error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
