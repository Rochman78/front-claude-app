import { NextRequest, NextResponse } from 'next/server';
import { checkVies } from '@/lib/services/viesService';

/**
 * GET /api/plugin/vies-check?vat=B26629626&country=ES
 * Vérifie un n° TVA intra à la VIES (préfixe pays ajouté s'il manque).
 * Réponse : { vatNumber, status: 'valid' | 'invalid' | 'unavailable', name?, code? }
 */
export async function GET(req: NextRequest) {
  const vat = req.nextUrl.searchParams.get('vat');
  if (!vat) {
    return NextResponse.json({ error: 'vat requis' }, { status: 400 });
  }
  const country = req.nextUrl.searchParams.get('country');
  return NextResponse.json(await checkVies(vat, country));
}
