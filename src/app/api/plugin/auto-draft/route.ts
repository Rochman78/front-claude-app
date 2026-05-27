import { NextRequest, NextResponse } from 'next/server';
import { processAutoDraft } from '@/lib/services/autoDraftService';

/**
 * POST /api/plugin/auto-draft
 * Génère un brouillon automatique pour UNE conversation (demande de devis, 1er mail).
 * Appelable :
 *  - manuellement / pour test : body { conversationId }
 *  - par un webhook Front : on tente d'extraire l'ID de conversation du payload.
 *
 * Protégé par AUTO_DRAFT_SECRET (?key=... ou header x-auto-draft-key) si défini.
 */
function authorized(req: NextRequest): boolean {
  const secret = process.env.AUTO_DRAFT_SECRET;
  if (!secret) return true; // non configuré → pas de blocage (dev)
  const key = new URL(req.url).searchParams.get('key') || req.headers.get('x-auto-draft-key');
  return key === secret;
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let conversationId = '';
  try {
    const body = await req.json();
    conversationId =
      body?.conversationId ||
      body?.conversation?.id ||
      body?.target?.data?.id ||
      body?.conversation_reference ||
      '';
  } catch { /* pas de body JSON, on tentera la query */ }

  if (!conversationId) {
    conversationId = new URL(req.url).searchParams.get('conversationId') || '';
  }
  if (!conversationId) {
    return NextResponse.json({ error: 'conversationId requis' }, { status: 400 });
  }

  const result = await processAutoDraft(conversationId);
  return NextResponse.json(result);
}
