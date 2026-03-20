import { NextRequest, NextResponse } from 'next/server';
import { frontFetch } from '@/lib/services/frontappService';

const FRONT_API_URL = 'https://api2.frontapp.com';

/**
 * POST /api/plugin/push-draft
 * Crée un brouillon dans Front App avec optionnellement un PDF en pièce jointe.
 *
 * Body: {
 *   conversationId: string,   — ID conversation Front App
 *   body: string,             — contenu HTML du brouillon
 *   pdfUrl?: string,          — URL du PDF à joindre (Pennylane)
 *   pdfFilename?: string      — nom du fichier PDF
 * }
 */
export async function POST(req: NextRequest) {
  try {
    if (!process.env.FRONT_API_TOKEN) {
      return NextResponse.json({ error: 'FRONT_API_TOKEN non configuré' }, { status: 500 });
    }

    const { conversationId, body, pdfUrl, pdfFilename } = await req.json();

    if (!conversationId || !body) {
      return NextResponse.json({ error: 'conversationId et body requis' }, { status: 400 });
    }

    const authHeader = `Bearer ${process.env.FRONT_API_TOKEN}`;

    // Résoudre channel_id et author_id
    const { channelId, authorId } = await resolveChannelAndAuthor(conversationId);

    // Télécharger le PDF si fourni
    let pdfBuffer: Buffer | null = null;
    if (pdfUrl) {
      try {
        console.log(`[plugin/push-draft] downloading PDF from ${pdfUrl.substring(0, 80)}...`);
        const pdfRes = await fetch(pdfUrl);
        if (pdfRes.ok) {
          pdfBuffer = Buffer.from(await pdfRes.arrayBuffer());
          console.log(`[plugin/push-draft] PDF downloaded: ${pdfBuffer.length} bytes`);
        } else {
          console.warn(`[plugin/push-draft] PDF download failed: ${pdfRes.status}`);
        }
      } catch (err) {
        console.warn('[plugin/push-draft] PDF download error:', err);
      }
    }

    // Supprimer les brouillons existants
    try {
      const existingRes = await frontFetch(`/conversations/${conversationId}/messages`);
      if (existingRes.ok) {
        const data = await existingRes.json();
        const drafts = (data._results || []).filter((m: Record<string, unknown>) => m.is_draft === true);
        for (const d of drafts) {
          await frontFetch(`/drafts/${d.id}`, { method: 'DELETE' }).catch(() => {});
        }
        if (drafts.length > 0) console.log(`[plugin/push-draft] deleted ${drafts.length} existing draft(s)`);
      }
    } catch { /* non bloquant */ }

    // Créer le brouillon
    let response: Response;

    if (pdfBuffer) {
      // Multipart avec pièce jointe PDF
      const filename = pdfFilename || 'devis.pdf';
      const boundary = `----FormBoundary${Date.now()}`;
      const parts: Buffer[] = [];

      const addField = (name: string, value: string) => {
        parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
      };

      addField('body', body);
      addField('mode', 'shared');
      if (channelId) addField('channel_id', channelId);
      if (authorId) addField('author_id', authorId);

      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="attachments[]"; filename="${filename}"\r\nContent-Type: application/pdf\r\n\r\n`
      ));
      parts.push(pdfBuffer);
      parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

      response = await fetch(`${FRONT_API_URL}/conversations/${conversationId}/drafts`, {
        method: 'POST',
        headers: {
          Authorization: authHeader,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body: Buffer.concat(parts),
      });
    } else {
      // JSON sans pièce jointe
      const payload: Record<string, string> = { body, mode: 'shared' };
      if (channelId) payload.channel_id = channelId;
      if (authorId) payload.author_id = authorId;

      response = await fetch(`${FRONT_API_URL}/conversations/${conversationId}/drafts`, {
        method: 'POST',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
    }

    console.log(`[plugin/push-draft] create draft → ${response.status} (pdf=${!!pdfBuffer})`);

    if (!response.ok) {
      const err = await response.text();
      return NextResponse.json({ error: `Front API: ${response.status} - ${err}` }, { status: response.status });
    }

    const text = await response.text();
    const result = text ? JSON.parse(text) : { success: true };
    return NextResponse.json(result);

  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Erreur inconnue';
    console.error('[plugin/push-draft] error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

async function resolveChannelAndAuthor(conversationId: string): Promise<{ channelId: string; authorId: string }> {
  let channelId = '';
  let authorId = '';

  try {
    const convRes = await frontFetch(`/conversations/${conversationId}`);
    if (!convRes.ok) return { channelId, authorId };
    const conv = await convRes.json();

    // Channel SMTP via inbox
    const inboxesUrl = conv._links?.related?.inboxes;
    if (inboxesUrl) {
      const authHeader = `Bearer ${process.env.FRONT_API_TOKEN}`;
      const inboxesRes = await fetch(inboxesUrl, { headers: { Authorization: authHeader, Accept: 'application/json' } });
      if (inboxesRes.ok) {
        const inboxes = (await inboxesRes.json())._results || [];
        for (const inbox of inboxes) {
          const chRes = await frontFetch(`/inboxes/${inbox.id}/channels`);
          if (chRes.ok) {
            const channels = (await chRes.json())._results || [];
            const smtp = channels.find((c: Record<string, unknown>) => c.type === 'smtp');
            if (smtp) { channelId = smtp.id as string; break; }
          }
        }
      }
    }

    // Author : assignee ou admin
    authorId = conv.assignee?.id || '';
    if (!authorId) {
      const tmRes = await frontFetch('/teammates');
      if (tmRes.ok) {
        const teammates = (await tmRes.json())._results || [];
        const admin = teammates.find((t: Record<string, unknown>) => t.is_admin && t.type !== 'api');
        if (admin) authorId = admin.id as string;
      }
    }
  } catch { /* fallback sans channel/author */ }

  return { channelId, authorId };
}
