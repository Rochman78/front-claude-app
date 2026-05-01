import { NextRequest, NextResponse } from 'next/server';
import { createQuote, uploadQuoteAppendix } from '@/lib/services/pennylaneService';

/**
 * POST /api/plugin/create-quote
 * Crée un devis Pennylane depuis le plugin Front App.
 * Supporte les appendices (images jointes au devis PDF).
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
      discountPercent: data.discountPercent,
      inboxName: data.inboxName,
    });

    // Uploader les appendices (images) si fournis
    const appendixImages = data.appendixImages as { data: string; mediaType: string; name: string }[] | undefined;
    if (appendixImages && appendixImages.length > 0 && result.quoteId) {
      console.log(`[plugin/create-quote] uploading ${appendixImages.length} appendices to quote ${result.quoteId}`);
      for (const img of appendixImages) {
        const uploadResult = await uploadQuoteAppendix(
          String(result.quoteId),
          img.data,
          img.mediaType,
          img.name,
        );
        if (!uploadResult.success) {
          console.warn(`[plugin/create-quote] appendix upload failed: ${uploadResult.error}`);
        }
      }
    }

    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Erreur inconnue';
    console.error('[plugin/create-quote] error:', msg);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
