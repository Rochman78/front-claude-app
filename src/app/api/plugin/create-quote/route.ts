import { NextRequest, NextResponse } from 'next/server';
import { createQuote } from '@/lib/services/pennylaneService';

/**
 * POST /api/plugin/create-quote
 * Crée un devis Pennylane depuis le plugin Front App.
 * Proxy vers le service existant pennylaneService.createQuote().
 *
 * Body: même format que /api/pennylane/create-quote
 * {
 *   customer: { name, firstName, lastName, email, phone, type, address, vatNumber },
 *   customerId?: string,
 *   lines: [{ type, label, quantity, unitPrice, vatRate, description }],
 *   subject?: string,
 *   deadline?: string,
 *   freeText?: string,
 *   inboxName?: string
 * }
 */
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
    console.error('[plugin/create-quote] error:', msg);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
