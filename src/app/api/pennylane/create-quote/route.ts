import { NextRequest, NextResponse } from 'next/server';
import { createQuote } from '@/lib/services/pennylaneService';

export async function POST(req: NextRequest) {
  try {
    if (!process.env.PENNYLANE_API_TOKEN) {
      return NextResponse.json({ error: 'PENNYLANE_API_TOKEN non configuré' }, { status: 500 });
    }

    const data = await req.json();
    const result = await createQuote({
      customer: data.customer,
      customerId: data.customerId,
      lines: data.lines || [],
      subject: data.subject,
      deadline: data.deadline,
      freeText: data.freeText,
      inboxName: data.inboxName,
    });

    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Erreur inconnue';
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
