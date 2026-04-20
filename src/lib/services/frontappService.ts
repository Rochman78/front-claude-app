/**
 * Service FrontApp — centralise tous les appels à l'API Front App.
 */

import { EXCLUDED_INBOX_NAMES } from '@/lib/stores';
import sharp from 'sharp';

const FRONT_API_URL = 'https://api2.frontapp.com';

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${process.env.FRONT_API_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

export async function frontFetch(path: string, options?: RequestInit): Promise<Response> {
  const t0 = Date.now();
  const res = await fetch(`${FRONT_API_URL}${path}`, { ...options, headers: { ...headers(), ...(options?.headers || {}) } });
  console.log(`[frontapp] ${options?.method || 'GET'} ${path} → ${res.status} (${Date.now() - t0}ms)`);
  return res;
}

export async function listInboxes(): Promise<{ id: string; name: string; address: string }[]> {
  const res = await frontFetch('/inboxes');
  if (!res.ok) throw new Error(`FrontApp API error: ${res.status}`);
  const data = await res.json();
  return (data._results || [])
    .filter((inbox: Record<string, unknown>) => {
      const name = ((inbox.name as string) || '').toLowerCase();
      return !EXCLUDED_INBOX_NAMES.some((ex) => name.includes(ex));
    })
    .map((inbox: Record<string, unknown>) => ({
      id: inbox.id,
      name: inbox.name,
      address: inbox.address,
    }));
}

export async function getConversationMessages(conversationId: string): Promise<{
  messages: Record<string, unknown>[];
  subject: string;
  partial: boolean;
}> {
  const res = await frontFetch(`/conversations/${conversationId}/messages`);

  if (!res.ok) {
    // Fallback si scope messages:read manquant
    const convRes = await frontFetch(`/conversations/${conversationId}`);
    if (!convRes.ok) throw new Error(`FrontApp error: ${convRes.status}`);
    const conv = await convRes.json();
    return {
      messages: conv.last_message ? [conv.last_message] : [],
      subject: conv.subject || '',
      partial: true,
    };
  }

  const data = await res.json();
  const messages = (data._results || []).filter((m: Record<string, unknown>) => !m.is_draft);

  // Fetch comments
  const commentsRes = await frontFetch(`/conversations/${conversationId}/comments`).catch(() => null);
  if (commentsRes?.ok) {
    const commentsData = await commentsRes.json();
    const comments = (commentsData._results || []).map((c: Record<string, unknown>) => ({
      ...c,
      is_comment: true,
      is_inbound: false,
    }));
    messages.push(...comments);
  }

  // Subject
  const convRes = await frontFetch(`/conversations/${conversationId}`);
  const conv = convRes.ok ? await convRes.json() : {};

  return {
    messages,
    subject: conv.subject || '',
    partial: false,
  };
}

/**
 * Récupère les images (PJ) d'une conversation Front.
 * Télécharge les attachments image > 10KB et les convertit en base64.
 */
export async function getConversationImages(conversationId: string): Promise<{ data: string; mediaType: string; name: string }[]> {
  const images: { data: string; mediaType: string; name: string }[] = [];
  const imageTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  const maxImages = 10;
  const minSize = 10 * 1024; // 10KB min — exclut logos/icônes
  const maxSize = 5 * 1024 * 1024; // 5MB max

  try {
    const res = await frontFetch(`/conversations/${conversationId}/messages`);
    if (!res.ok) return [];
    const data = await res.json();
    const messages = data._results || [];

    for (const msg of messages) {
      if (images.length >= maxImages) break;
      const attachments = msg.attachments || [];
      for (const att of attachments) {
        if (images.length >= maxImages) break;
        const contentType = att.content_type || att.contentType || '';
        if (!imageTypes.includes(contentType)) continue;
        // Exclure les images inline (logos de signature dans le HTML)
        if (att.metadata?.is_inline) {
          console.log(`[frontapp] skipping inline image ${att.filename} (cid:${att.metadata.cid})`);
          continue;
        }
        const filename = (att.filename || '').toLowerCase();
        // Exclure les logos, signatures, icônes par nom de fichier
        if (/^logo|signature|banner|bannière|icon/i.test(filename)) {
          console.log(`[frontapp] skipping logo/signature image: ${att.filename}`);
          continue;
        }
        const size = att.size || 0;
        if (size > 0 && size < minSize) {
          console.log(`[frontapp] skipping small image ${att.filename} (${size} bytes)`);
          continue;
        }
        if (size > maxSize) {
          console.log(`[frontapp] skipping large image ${att.filename} (${size} bytes)`);
          continue;
        }

        // Télécharger l'attachment via l'URL Front
        try {
          const attUrl = att.url || `${FRONT_API_URL}/download/${att.id}`;
          const attRes = await fetch(attUrl, {
            headers: { Authorization: `Bearer ${process.env.FRONT_API_TOKEN}` },
          });
          if (!attRes.ok) {
            console.warn(`[frontapp] failed to download ${att.filename}: ${attRes.status}`);
            continue;
          }
          let imgBuffer = Buffer.from(await attRes.arrayBuffer());
          // Vérifier la taille réelle si pas connue
          if (imgBuffer.byteLength < minSize) {
            console.log(`[frontapp] skipping small image ${att.filename} (${imgBuffer.byteLength} bytes actual)`);
            continue;
          }
          // Compresser si trop gros (base64 ajoute ~33%, donc max ~3.7MB en raw pour rester sous 5MB en base64)
          let finalMediaType = contentType;
          const maxBase64Size = 3700000;
          if (imgBuffer.byteLength > maxBase64Size) {
            console.log(`[frontapp] compressing ${att.filename} (${Math.round(imgBuffer.byteLength / 1024)}KB → target < 3.7MB)`);
            try {
              imgBuffer = await sharp(imgBuffer)
                .resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true })
                .jpeg({ quality: 80 })
                .toBuffer();
              finalMediaType = 'image/jpeg';
              console.log(`[frontapp] compressed to ${Math.round(imgBuffer.byteLength / 1024)}KB`);
            } catch (compressErr) {
              console.warn(`[frontapp] compression failed for ${att.filename}:`, compressErr);
              if (imgBuffer.byteLength > maxSize) continue;
            }
          }
          const base64 = imgBuffer.toString('base64');
          images.push({ data: base64, mediaType: finalMediaType, name: att.filename || 'image' });
          console.log(`[frontapp] extracted image: ${att.filename} (${finalMediaType}, ${Math.round(imgBuffer.byteLength / 1024)}KB)`);
        } catch (err) {
          console.warn(`[frontapp] failed to download attachment ${att.filename}:`, err);
        }
      }
    }
  } catch (err) {
    console.warn('[frontapp] getConversationImages error:', err);
  }

  return images;
}

export async function resolveChannelId(conversationId: string): Promise<string> {
  const convRes = await frontFetch(`/conversations/${conversationId}`);
  if (!convRes.ok) throw new Error(`Impossible de récupérer la conversation: ${convRes.status}`);
  const conv = await convRes.json();

  // Try x-front-channel-id header
  let channelId = conv.last_message?.metadata?.headers?.['x-front-channel-id'] || '';

  // Fallback: inbox channels
  if (!channelId && conv._links?.related?.inboxes) {
    const inboxesRes = await fetch(conv._links.related.inboxes, { headers: headers() });
    if (inboxesRes.ok) {
      const inboxes = (await inboxesRes.json())._results || [];
      if (inboxes.length > 0) {
        const channelsRes = await frontFetch(`/inboxes/${inboxes[0].id}/channels`);
        if (channelsRes.ok) {
          const channels = (await channelsRes.json())._results || [];
          if (channels.length > 0) channelId = channels[0].id;
        }
      }
    }
  }

  if (!channelId) throw new Error('Impossible de trouver le channel_id');
  return channelId;
}

export async function resolveAuthorId(conversationId: string): Promise<string | undefined> {
  const convRes = await frontFetch(`/conversations/${conversationId}`);
  if (!convRes.ok) return undefined;
  const conv = await convRes.json();
  return conv.assignee?.id || conv.last_message?.author?.id;
}

export function textToHtml(text: string): string {
  return text.split('\n').map((line: string) => line || '<br>').join('<br>');
}

export async function createDraft(conversationId: string, body: string, channelId: string, authorId?: string): Promise<Record<string, unknown>> {
  const payload: Record<string, unknown> = {
    body: textToHtml(body),
    channel_id: channelId,
    mode: 'shared',
  };
  if (authorId) payload.author_id = authorId;

  const res = await frontFetch(`/conversations/${conversationId}/drafts`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`FrontApp API error: ${res.status} - ${errorText}`);
  }

  const text = await res.text();
  const data = text ? JSON.parse(text) : { success: true };
  data.frontUrl = `https://app.frontapp.com/open/${conversationId}`;
  return data;
}
