import { NextRequest, NextResponse } from 'next/server';
import { frontFetch } from '@/lib/services/frontappService';

/**
 * POST /api/plugin/delete-drafts
 * Supprime tous les brouillons existants d'une conversation Front App.
 * Doit être appelé AVANT createDraft pour éviter les doublons.
 *
 * Body: { conversationId: string }
 */
export async function POST(req: NextRequest) {
  try {
    if (!process.env.FRONT_API_TOKEN) {
      return NextResponse.json({ error: 'FRONT_API_TOKEN non configuré' }, { status: 500 });
    }

    const { conversationId } = await req.json();

    if (!conversationId) {
      return NextResponse.json({ error: 'conversationId requis' }, { status: 400 });
    }

    // Lister les messages de la conversation et filtrer les brouillons
    const res = await frontFetch(`/conversations/${conversationId}/messages`);
    if (!res.ok) {
      const errorText = await res.text();
      return NextResponse.json({ error: `Erreur Front API: ${res.status} - ${errorText}` }, { status: res.status });
    }

    const data = await res.json();
    const drafts = (data._results || []).filter((m: Record<string, unknown>) => m.is_draft === true);

    console.log(`[plugin/delete-drafts] conv=${conversationId} found ${drafts.length} draft(s)`);

    // Supprimer chaque brouillon
    let deleted = 0;
    for (const draft of drafts) {
      const delRes = await frontFetch(`/drafts/${draft.id}`, { method: 'DELETE' });
      if (delRes.ok || delRes.status === 204) {
        deleted++;
      } else {
        console.warn(`[plugin/delete-drafts] failed to delete ${draft.id}: ${delRes.status}`);
      }
    }

    return NextResponse.json({ deleted, total: drafts.length });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Erreur inconnue';
    console.error('[plugin/delete-drafts] error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
