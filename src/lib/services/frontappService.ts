/**
 * Service FrontApp — centralise tous les appels à l'API Front App.
 */

import { EXCLUDED_INBOX_NAMES } from '@/lib/stores';

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
