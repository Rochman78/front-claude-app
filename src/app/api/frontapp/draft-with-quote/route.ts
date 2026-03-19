import { NextRequest, NextResponse } from 'next/server';

const FRONT_API_URL = 'https://api2.frontapp.com';

async function getChannelAndAuthor(conversationId: string): Promise<{ channelId: string; authorId: string }> {
  const headers = {
    Authorization: `Bearer ${process.env.FRONT_API_TOKEN}`,
    'Content-Type': 'application/json',
  };

  let channelId = '';
  let authorId = '';

  const convRes = await fetch(`${FRONT_API_URL}/conversations/${conversationId}`, { headers });
  if (!convRes.ok) return { channelId, authorId };
  const conv = await convRes.json();

  // Find SMTP channel via inbox
  const inboxesUrl = conv._links?.related?.inboxes;
  if (inboxesUrl) {
    const inboxesRes = await fetch(inboxesUrl, { headers });
    if (inboxesRes.ok) {
      const inboxes = (await inboxesRes.json())._results || [];
      for (const inbox of inboxes) {
        const chRes = await fetch(`${FRONT_API_URL}/inboxes/${inbox.id}/channels`, { headers });
        if (chRes.ok) {
          const channels = (await chRes.json())._results || [];
          const smtp = channels.find((c: Record<string, unknown>) => c.type === 'smtp');
          if (smtp) { channelId = smtp.id as string; break; }
        }
      }
    }
  }

  // Find admin teammate
  const tmRes = await fetch(`${FRONT_API_URL}/teammates`, { headers });
  if (tmRes.ok) {
    const teammates = (await tmRes.json())._results || [];
    const admin = teammates.find((t: Record<string, unknown>) => t.is_admin && t.type !== 'api');
    if (admin) authorId = admin.id as string;
  }

  return { channelId, authorId };
}

export async function POST(req: NextRequest) {
  try {
    const { conversation_id, body, pdf_url, quote_number } = await req.json();

    if (!conversation_id || !body) {
      return NextResponse.json({ error: 'conversation_id et body requis' }, { status: 400 });
    }

    const { channelId, authorId } = await getChannelAndAuthor(conversation_id);
    const authHeader = `Bearer ${process.env.FRONT_API_TOKEN}`;

    // Delete existing shared drafts
    const existingRes = await fetch(`${FRONT_API_URL}/conversations/${conversation_id}/drafts`, {
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
    });
    if (existingRes.ok) {
      const drafts = (await existingRes.json())._results || [];
      for (const d of drafts) {
        if (d.draft_mode === 'shared') {
          await fetch(`${FRONT_API_URL}/drafts/${d.id}`, {
            method: 'DELETE',
            headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
            body: JSON.stringify({ version: d.version || '' }),
          }).catch(() => {});
        }
      }
    }

    // Download PDF if provided
    let pdfBuffer: Buffer | null = null;
    const pdfFilename = quote_number ? `Devis-${quote_number}.pdf` : 'devis.pdf';
    if (pdf_url) {
      try {
        const pdfRes = await fetch(pdf_url);
        if (pdfRes.ok) pdfBuffer = Buffer.from(await pdfRes.arrayBuffer());
      } catch { /* ignore */ }
    }

    // Convert text to HTML
    const htmlBody = body.split('\n').map((l: string) => l || '<br>').join('<br>');

    let response: Response;
    if (pdfBuffer) {
      // Multipart with attachment
      const boundary = `----FormBoundary${Date.now()}`;
      const parts: Buffer[] = [];
      const addField = (name: string, value: string) => {
        parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
      };
      addField('body', htmlBody);
      addField('mode', 'shared');
      if (channelId) addField('channel_id', channelId);
      if (authorId) addField('author_id', authorId);
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="attachments[]"; filename="${pdfFilename}"\r\nContent-Type: application/pdf\r\n\r\n`
      ));
      parts.push(pdfBuffer);
      parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

      response = await fetch(`${FRONT_API_URL}/conversations/${conversation_id}/drafts`, {
        method: 'POST',
        headers: { Authorization: authHeader, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body: Buffer.concat(parts),
      });
    } else {
      const draftBody: Record<string, string> = { body: htmlBody, mode: 'shared' };
      if (channelId) draftBody.channel_id = channelId;
      if (authorId) draftBody.author_id = authorId;

      response = await fetch(`${FRONT_API_URL}/conversations/${conversation_id}/drafts`, {
        method: 'POST',
        headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify(draftBody),
      });
    }

    if (!response.ok) {
      const err = await response.text();
      return NextResponse.json({ error: `FrontApp error: ${response.status} - ${err}` }, { status: response.status });
    }

    const text = await response.text();
    const result = text ? JSON.parse(text) : {};
    result.frontUrl = `https://app.frontapp.com/open/${conversation_id}`;
    return NextResponse.json(result);

  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Erreur inconnue';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
