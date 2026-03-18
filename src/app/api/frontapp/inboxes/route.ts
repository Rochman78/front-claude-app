import { NextResponse } from 'next/server';

const FRONT_API_URL = 'https://api2.frontapp.com';

export async function GET() {
  try {
    if (!process.env.FRONT_API_TOKEN) {
      return NextResponse.json({ error: 'FRONT_API_TOKEN non configuré' }, { status: 500 });
    }

    const response = await fetch(`${FRONT_API_URL}/inboxes`, {
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

    const inboxes = (data._results || []).map((inbox: Record<string, unknown>) => ({
      id: inbox.id,
      name: inbox.name,
      address: inbox.address,
    }));

    return NextResponse.json(inboxes);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Erreur inconnue';
    console.error('FrontApp inboxes error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
