import { NextResponse } from 'next/server';
import { listInboxes } from '@/lib/services/frontappService';

export async function GET() {
  try {
    if (!process.env.FRONT_API_TOKEN) {
      return NextResponse.json({ error: 'FRONT_API_TOKEN non configuré' }, { status: 500 });
    }
    const inboxes = await listInboxes();
    return NextResponse.json(inboxes);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Erreur inconnue';
    console.error('FrontApp inboxes error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
