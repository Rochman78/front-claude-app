import { NextRequest, NextResponse } from 'next/server';

const FRONT_API_URL = 'https://api2.frontapp.com';

/**
 * POST /api/plugin/send-batch-mail
 *
 * Envoie un mail DIRECTEMENT via un canal Front (nouvelle conv), sans
 * dépendre d'un last_message existant côté conv. Utilisé par le script
 * scripts/batch-mail/send_drafts.py pour l'opération "doublon expédition"
 * (03/07/2026) : 143 mails à envoyer sur 8 canaux boutique.
 *
 * Diffère de /api/plugin/send-message qui fait POST /conversations/{id}/messages
 * (reply → exige un last_message). Ici on fait POST /channels/{ch}/messages
 * pour créer une NOUVELLE conv d'envoi.
 *
 * Utilise FRONT_API_TOKEN_SEND (scope messages:send isolé) avec fallback
 * sur FRONT_API_TOKEN. Ref : https://dev.frontapp.com/reference/create-message
 *
 * Body : {
 *   channelId: string,       — cha_xxx du canal boutique
 *   to: string[],             — destinataire(s)
 *   subject: string,
 *   body: string (HTML),
 * }
 */
export async function POST(req: NextRequest) {
  try {
    const { channelId, to, subject, body } = await req.json();
    if (!channelId || !to || !Array.isArray(to) || to.length === 0 || !body) {
      return NextResponse.json({ error: 'channelId, to (array), body requis' }, { status: 400 });
    }

    const token = process.env.FRONT_API_TOKEN_SEND || process.env.FRONT_API_TOKEN;
    if (!token) {
      return NextResponse.json({ error: 'FRONT_API_TOKEN(_SEND) non configuré' }, { status: 500 });
    }

    const payload: Record<string, unknown> = {
      to,
      subject: subject || '',
      body,
      body_format: 'html',
      should_add_default_signature: true,
      options: { archive: false, tags: [] },
    };

    const url = `${FRONT_API_URL}/channels/${channelId}/messages`;
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    // 1er essai
    let response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
    let text = await response.text().catch(() => '');

    // Retry sur 429 avec respect du Retry-After
    if (response.status === 429) {
      const retryAfterHeader = response.headers.get('retry-after');
      const errMatch = /retry in (\d+)\s*milliseconds/i.exec(text);
      let waitMs = 2000;
      if (retryAfterHeader) waitMs = parseFloat(retryAfterHeader) * 1000;
      else if (errMatch) waitMs = parseInt(errMatch[1], 10);
      waitMs = Math.min(Math.max(waitMs, 1000), 30000);
      console.warn(`[send-batch-mail] 429, retry in ${waitMs}ms`);
      await new Promise((r) => setTimeout(r, waitMs));
      response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
      text = await response.text().catch(() => '');
    }

    if (!response.ok) {
      console.error(`[send-batch-mail] Front ${response.status}: ${text.substring(0, 300)}`);
      return NextResponse.json({ error: `Front API: ${response.status} - ${text}` }, { status: response.status });
    }

    const result = text ? JSON.parse(text) : { success: true };
    // Extraire conv_id du _links pour retour au script
    let sentConvId = '';
    if (result?._links?.related?.conversation) {
      const url: string = result._links.related.conversation;
      sentConvId = url.replace(/\/$/, '').split('/').pop() || '';
    }
    console.log(`[send-batch-mail] ✓ envoyé channel=${channelId} to=${to[0]} msg=${result.id || '?'} conv=${sentConvId}`);
    return NextResponse.json({ ...result, sentConvId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Erreur inconnue';
    console.error('[send-batch-mail] error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
