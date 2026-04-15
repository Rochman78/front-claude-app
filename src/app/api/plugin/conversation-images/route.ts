import { NextRequest, NextResponse } from 'next/server';
import { getConversationImages } from '@/lib/services/frontappService';

/**
 * GET /api/plugin/conversation-images?front_conversation_id=X
 * Retourne les images (PJ) d'une conversation Front en base64.
 */
export async function GET(req: NextRequest) {
  try {
    const frontConvId = req.nextUrl.searchParams.get('front_conversation_id');
    if (!frontConvId) {
      return NextResponse.json({ error: 'front_conversation_id requis' }, { status: 400 });
    }

    const images = await getConversationImages(frontConvId);
    return NextResponse.json({ images });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Erreur inconnue';
    console.error('[conversation-images] error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
