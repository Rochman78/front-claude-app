import { NextRequest, NextResponse } from 'next/server';
import pool, { initDB } from '@/lib/db';

/**
 * GET /api/plugin/templates?store_code=XXX
 * Retourne les templates disponibles pour une boutique.
 */
export async function GET(req: NextRequest) {
  try {
    await initDB();
    const storeCode = req.nextUrl.searchParams.get('store_code') || '';

    const { rows } = await pool.query(
      "SELECT id, name, summary, content, attachment_url, procedure_url FROM templates WHERE store_code = 'all' OR store_code = $1 OR store_code LIKE '%' || $1 || '%' ORDER BY name",
      [storeCode]
    );

    return NextResponse.json(rows);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Erreur inconnue';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
