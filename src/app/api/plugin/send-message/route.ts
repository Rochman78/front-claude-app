import { NextRequest, NextResponse } from 'next/server';
import { resolveChannelAndAuthor } from '@/app/api/plugin/push-draft/route';

const FRONT_API_URL = 'https://api2.frontapp.com';

/**
 * POST /api/plugin/send-message
 *
 * Envoie un message dans une conversation Front existante (≠ brouillon).
 * Utilisé par l'auto-send des devis quand AUTO_SEND_ENABLED=true.
 *
 * Body : { conversationId: string, body: string (HTML) }
 *
 * Réutilise la résolution canal/auteur de push-draft (même logique de fallback
 * pour les types de canal exotiques). Endpoint Front : POST /conversations/{id}/messages.
 * Référence : https://dev.frontapp.com/reference/create-message-reply
 */
export async function POST(req: NextRequest) {
  try {
    const { conversationId, body } = await req.json();
    if (!conversationId || !body) {
      return NextResponse.json({ error: 'conversationId et body requis' }, { status: 400 });
    }

    // On préfère un token dédié à l'envoi (scope messages:send isolé), avec fallback
    // sur le token principal si la variable séparée n'est pas définie. Permet de
    // limiter la portée d'un éventuel leak du token send-only.
    const token = process.env.FRONT_API_TOKEN_SEND || process.env.FRONT_API_TOKEN;
    if (!token) return NextResponse.json({ error: 'FRONT_API_TOKEN(_SEND) non configurée' }, { status: 500 });

    const { channelId, authorId } = await resolveChannelAndAuthor(conversationId);
    console.log(`[send-message] conv=${conversationId} channel=${channelId || '(none)'} author=${authorId || '(none)'}`);

    const authHeader = `Bearer ${token}`;
    const baseHeaders = { Authorization: authHeader, 'Content-Type': 'application/json', Accept: 'application/json' };

    // options.archive: false → la conv reste en inbox pour que l'équipe puisse
    // vérifier ce qui vient d'être envoyé automatiquement.
    const payload: Record<string, unknown> = {
      body,
      should_add_default_signature: true,
      options: { archive: false },
    };
    if (channelId) payload.channel_id = channelId;
    if (authorId) payload.author_id = authorId;

    const url = `${FRONT_API_URL}/conversations/${conversationId}/messages`;

    // 1er essai
    let response = await fetch(url, { method: 'POST', headers: baseHeaders, body: JSON.stringify(payload) });
    let text = await response.text().catch(() => '');

    // Retry 1 : 429 (rate limit) avec respect du Retry-After
    if (response.status === 429) {
      const retryAfterHeader = response.headers.get('retry-after');
      const errMatch = /retry in (\d+)\s*milliseconds/i.exec(text);
      let waitMs = 2000;
      if (retryAfterHeader) waitMs = parseFloat(retryAfterHeader) * 1000;
      else if (errMatch) waitMs = parseInt(errMatch[1], 10);
      waitMs = Math.min(Math.max(waitMs, 1000), 30000);
      console.warn(`[send-message] 429, retry in ${waitMs}ms`);
      await new Promise((r) => setTimeout(r, waitMs));
      response = await fetch(url, { method: 'POST', headers: baseHeaders, body: JSON.stringify(payload) });
      text = await response.text().catch(() => '');
    }

    // Retry 2 : 403 channel_id mismatch → réessai sans channel_id (Front choisit)
    if (response.status === 403 && /channel/i.test(text)) {
      console.warn('[send-message] 403 channel mismatch, retry without channel_id');
      const fallback: Record<string, unknown> = { ...payload };
      delete fallback.channel_id;
      response = await fetch(url, { method: 'POST', headers: baseHeaders, body: JSON.stringify(fallback) });
      text = await response.text().catch(() => '');
    }

    if (!response.ok) {
      console.error(`[send-message] Front ${response.status}: ${text.substring(0, 300)}`);
      return NextResponse.json({ error: `Front API: ${response.status} - ${text}` }, { status: response.status });
    }

    const result = text ? JSON.parse(text) : { success: true };
    console.log(`[send-message] ✓ envoyé conv=${conversationId} message_id=${result.id || '?'}`);
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Erreur inconnue';
    console.error('[send-message] error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
