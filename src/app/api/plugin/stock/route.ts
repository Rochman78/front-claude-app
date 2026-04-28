import { NextRequest, NextResponse } from 'next/server';
import { getStockBySku } from '@/lib/services/octopiaService';

/**
 * GET /api/plugin/stock?sku=3760388670833
 * Retourne le stock disponible pour un SKU donné.
 */
export async function GET(req: NextRequest) {
  try {
    const sku = req.nextUrl.searchParams.get('sku');
    if (!sku) {
      return NextResponse.json({ error: 'sku requis' }, { status: 400 });
    }

    const available = await getStockBySku(sku);
    return NextResponse.json({ sku, available });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Erreur inconnue';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
