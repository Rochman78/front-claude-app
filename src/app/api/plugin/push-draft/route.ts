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

    // Résoudre channel_id et author_id (adapté au type de conversation)
    const { channelId, authorId, convType } = await resolveChannelAndAuthor(conversationId);
    console.log(`[plugin/push-draft] convType=${convType} channelId=${channelId || '(none)'} authorId=${authorId || '(none)'}`);

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
          let version = d.version;
          if (!version) {
            const msgRes = await frontFetch(`/messages/${d.id}`).catch(() => null);
            if (msgRes?.ok) version = (await msgRes.json()).version;
          }
          await frontFetch(`/drafts/${d.id}`, {
            method: 'DELETE',
            body: JSON.stringify({ version }),
          }).catch(() => {});
        }
        if (drafts.length > 0) {
          console.log(`[plugin/push-draft] deleted ${drafts.length} existing draft(s), waiting 1500ms...`);
          await new Promise((r) => setTimeout(r, 1500));
        }
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
      addField('should_add_default_signature', 'true');
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
      const payload: Record<string, unknown> = { body, mode: 'shared', should_add_default_signature: true };
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
    // On consomme le body une seule fois pour pouvoir le réutiliser pour la
    // détection 400/channel + la réponse finale.
    let firstText = await response.text();

    // Si 429 (Front rate limit), respecter le retry-after indiqué et retenter une fois.
    // Front renvoie un body type {"_error":{"status":429,..."message":"Rate limit exceeded. Please retry in <N> milliseconds."}}.
    if (response.status === 429) {
      const m = firstText.match(/retry in (\d+) milliseconds/i);
      const waitMs = m ? Math.min(parseInt(m[1], 10) + 300, 20000) : 3000;
      console.log(`[plugin/push-draft] 429 rate limit → wait ${waitMs}ms and retry`);
      await new Promise((r) => setTimeout(r, waitMs));
      if (pdfBuffer) {
        const filenameR = pdfFilename || 'devis.pdf';
        const boundaryR = `----FormBoundary${Date.now()}`;
        const partsR: Buffer[] = [];
        const addFieldR = (name: string, value: string) => {
          partsR.push(Buffer.from(`--${boundaryR}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
        };
        addFieldR('body', body);
        addFieldR('mode', 'shared');
        addFieldR('should_add_default_signature', 'true');
        if (channelId) addFieldR('channel_id', channelId);
        if (authorId) addFieldR('author_id', authorId);
        partsR.push(Buffer.from(`--${boundaryR}\r\nContent-Disposition: form-data; name="attachments[]"; filename="${filenameR}"\r\nContent-Type: application/pdf\r\n\r\n`));
        partsR.push(pdfBuffer);
        partsR.push(Buffer.from(`\r\n--${boundaryR}--\r\n`));
        response = await fetch(`${FRONT_API_URL}/conversations/${conversationId}/drafts`, {
          method: 'POST',
          headers: { Authorization: authHeader, 'Content-Type': `multipart/form-data; boundary=${boundaryR}` },
          body: Buffer.concat(partsR),
        });
      } else {
        const payloadR: Record<string, unknown> = { body, mode: 'shared', should_add_default_signature: true };
        if (channelId) payloadR.channel_id = channelId;
        if (authorId) payloadR.author_id = authorId;
        response = await fetch(`${FRONT_API_URL}/conversations/${conversationId}/drafts`, {
          method: 'POST',
          headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
          body: JSON.stringify(payloadR),
        });
      }
      firstText = await response.text();
      console.log(`[plugin/push-draft] after 429 retry → ${response.status}`);
    }

    // Si 403 "channel type does not match", réessayer sans channel_id
    if (response.status === 403 && channelId) {
      console.log('[plugin/push-draft] 403 with channel_id, retrying without channel_id...');
      let retryResponse: Response;
      if (pdfBuffer) {
        const filename = pdfFilename || 'devis.pdf';
        const boundary2 = `----FormBoundary${Date.now()}`;
        const parts2: Buffer[] = [];
        const addField2 = (name: string, value: string) => {
          parts2.push(Buffer.from(`--${boundary2}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
        };
        addField2('body', body);
        addField2('mode', 'shared');
        addField2('should_add_default_signature', 'true');
        if (authorId) addField2('author_id', authorId);
        parts2.push(Buffer.from(`--${boundary2}\r\nContent-Disposition: form-data; name="attachments[]"; filename="${filename}"\r\nContent-Type: application/pdf\r\n\r\n`));
        parts2.push(pdfBuffer);
        parts2.push(Buffer.from(`\r\n--${boundary2}--\r\n`));
        retryResponse = await fetch(`${FRONT_API_URL}/conversations/${conversationId}/drafts`, {
          method: 'POST',
          headers: { Authorization: authHeader, 'Content-Type': `multipart/form-data; boundary=${boundary2}` },
          body: Buffer.concat(parts2),
        });
      } else {
        const retryPayload: Record<string, unknown> = { body, mode: 'shared', should_add_default_signature: true };
        if (authorId) retryPayload.author_id = authorId;
        retryResponse = await fetch(`${FRONT_API_URL}/conversations/${conversationId}/drafts`, {
          method: 'POST',
          headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
          body: JSON.stringify(retryPayload),
        });
      }
      console.log(`[plugin/push-draft] retry without channel → ${retryResponse.status}`);
      if (retryResponse.ok) {
        const text2 = await retryResponse.text();
        return NextResponse.json(text2 ? JSON.parse(text2) : { success: true });
      }
      const err2 = await retryResponse.text();
      return NextResponse.json({ error: `Front API: ${retryResponse.status} - ${err2}` }, { status: retryResponse.status });
    }

    // Si 400 "channel_id missing" et qu'on n'avait pas envoyé de channel_id,
    // tenter de retrouver n'importe quel canal de la conv et réessayer AVEC.
    if (response.status === 400 && !channelId && /channel/i.test(firstText)) {
      console.log('[plugin/push-draft] 400 channel_id missing — tentative de fallback channel...');
      let fallbackChannel = '';
      try {
        const convRes = await frontFetch(`/conversations/${conversationId}`);
        if (convRes.ok) {
          const conv = await convRes.json();
          const inboxesUrl = conv._links?.related?.inboxes;
          if (inboxesUrl) {
            const inbRes = await fetch(inboxesUrl, { headers: { Authorization: authHeader, Accept: 'application/json' } });
            if (inbRes.ok) {
              const inboxes = (await inbRes.json())._results || [];
              for (const inbox of inboxes) {
                const chRes = await frontFetch(`/inboxes/${inbox.id}/channels`);
                if (chRes.ok) {
                  const channels = (await chRes.json())._results || [];
                  if (channels.length > 0) {
                    const smtp = channels.find((c: Record<string, unknown>) => c.type === 'smtp');
                    const picked = smtp || channels[0];
                    fallbackChannel = picked.id as string;
                    console.log(`[plugin/push-draft] 400 fallback channel: ${fallbackChannel} (type=${picked.type}) from inbox ${inbox.id}`);
                    break;
                  }
                }
              }
            }
          }
        }
      } catch (e) { console.warn('[plugin/push-draft] 400 fallback lookup error:', e); }

      if (fallbackChannel) {
        let retryResponse2: Response;
        if (pdfBuffer) {
          const filename = pdfFilename || 'devis.pdf';
          const boundary3 = `----FormBoundary${Date.now()}`;
          const parts3: Buffer[] = [];
          const addField3 = (name: string, value: string) => {
            parts3.push(Buffer.from(`--${boundary3}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
          };
          addField3('body', body);
          addField3('mode', 'shared');
          addField3('should_add_default_signature', 'true');
          addField3('channel_id', fallbackChannel);
          if (authorId) addField3('author_id', authorId);
          parts3.push(Buffer.from(`--${boundary3}\r\nContent-Disposition: form-data; name="attachments[]"; filename="${filename}"\r\nContent-Type: application/pdf\r\n\r\n`));
          parts3.push(pdfBuffer);
          parts3.push(Buffer.from(`\r\n--${boundary3}--\r\n`));
          retryResponse2 = await fetch(`${FRONT_API_URL}/conversations/${conversationId}/drafts`, {
            method: 'POST',
            headers: { Authorization: authHeader, 'Content-Type': `multipart/form-data; boundary=${boundary3}` },
            body: Buffer.concat(parts3),
          });
        } else {
          const retryPayload2: Record<string, unknown> = { body, mode: 'shared', should_add_default_signature: true, channel_id: fallbackChannel };
          if (authorId) retryPayload2.author_id = authorId;
          retryResponse2 = await fetch(`${FRONT_API_URL}/conversations/${conversationId}/drafts`, {
            method: 'POST',
            headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
            body: JSON.stringify(retryPayload2),
          });
        }
        console.log(`[plugin/push-draft] retry with fallback channel → ${retryResponse2.status}`);
        if (retryResponse2.ok) {
          const text3 = await retryResponse2.text();
          return NextResponse.json(text3 ? JSON.parse(text3) : { success: true });
        }
        const err3 = await retryResponse2.text();
        return NextResponse.json({ error: `Front API: ${retryResponse2.status} - ${err3}` }, { status: retryResponse2.status });
      }
    }

    if (!response.ok) {
      return NextResponse.json({ error: `Front API: ${response.status} - ${firstText}` }, { status: response.status });
    }

    const result = firstText ? JSON.parse(firstText) : { success: true };
    return NextResponse.json(result);

  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Erreur inconnue';
    console.error('[plugin/push-draft] error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

async function resolveChannelAndAuthor(conversationId: string): Promise<{ channelId: string; authorId: string; convType: string }> {
  let channelId = '';
  let authorId = '';
  let convType = 'unknown';

  try {
    const convRes = await frontFetch(`/conversations/${conversationId}`);
    if (!convRes.ok) return { channelId, authorId, convType };
    const conv = await convRes.json();
    convType = conv.type || 'unknown';

    // Si convType est non-spécifique ('unknown' ou 'conversation' que Front renvoie
    // comme catégorie fourre-tout), déduire depuis le type du dernier message.
    const isNonSpecific = (t: string) => t === 'unknown' || t === 'conversation';
    if (isNonSpecific(convType) && conv.last_message?.type) {
      convType = conv.last_message.type === 'front_chat' ? 'chat' : conv.last_message.type;
      console.log(`[push-draft/resolve] convType deduced from last_message.type: ${conv.last_message.type} → ${convType}`);
    }

    // Si toujours non-spécifique (last_message absent), récupérer les messages pour déduire le type
    if (isNonSpecific(convType)) {
      try {
        const msgsRes = await frontFetch(`/conversations/${conversationId}/messages`);
        if (msgsRes.ok) {
          const msgsData = await msgsRes.json();
          const msgs = (msgsData._results || []).filter((m: Record<string, unknown>) => !m.is_draft);
          if (msgs.length > 0) {
            const lastMsg = msgs[0]; // _results est trié du plus récent au plus ancien
            const msgType = lastMsg.type as string;
            console.log(`[push-draft/resolve] last message type from API: ${msgType} (id=${lastMsg.id})`);
            if (msgType === 'email' || msgType === 'smtp') {
              convType = 'email';
            } else if (msgType === 'front_chat') {
              convType = 'chat';
            } else {
              convType = msgType || 'unknown';
            }
            console.log(`[push-draft/resolve] deduced type from messages: ${convType}`);
          }
        }
      } catch { /* non bloquant */ }
    }

    console.log(`[push-draft/resolve] conv type=${convType} subject="${conv.subject}" last_message_id=${conv.last_message?.id}`);

    // Stratégie 1 : extraire le channel_id du dernier message (fonctionne pour tous les types)
    if (conv.last_message?.metadata?.headers?.['x-front-channel-id']) {
      channelId = conv.last_message.metadata.headers['x-front-channel-id'];
      console.log(`[push-draft/resolve] channel from last_message headers: ${channelId}`);
    }

    // Stratégie 2 : lister les canaux de l'inbox et trouver le bon type
    if (!channelId) {
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
              console.log(`[push-draft/resolve] inbox ${inbox.id} channels:`, channels.map((c: Record<string, unknown>) => ({ id: c.id, type: c.type })));

              if (convType === 'email') {
                // Email : chercher canal SMTP
                const smtp = channels.find((c: Record<string, unknown>) => c.type === 'smtp');
                if (smtp) { channelId = smtp.id as string; break; }
              } else {
                // Chat/custom/unknown : essayer de matcher le canal exact
                // Si le sujet contient "Instagram", chercher le canal Instagram
                // Si le sujet contient "Facebook", chercher le canal Facebook
                // Sinon front_chat > premier custom > premier non-SMTP
                const subject = (conv.subject || '').toLowerCase();
                let match;
                if (subject.includes('instagram')) {
                  match = channels.find((c: Record<string, unknown>) => ((c.name || c.address || '') as string).toLowerCase().includes('instagram'));
                } else if (subject.includes('facebook')) {
                  match = channels.find((c: Record<string, unknown>) => ((c.name || c.address || '') as string).toLowerCase().includes('facebook'));
                }
                if (!match) {
                  const frontChat = channels.find((c: Record<string, unknown>) => c.type === 'front_chat');
                  const custom = channels.find((c: Record<string, unknown>) => c.type === 'custom');
                  const nonSmtp = channels.find((c: Record<string, unknown>) => c.type !== 'smtp');
                  match = frontChat || custom || nonSmtp || channels[0];
                }
                if (match) {
                  channelId = match.id as string;
                  console.log(`[push-draft/resolve] selected channel: ${channelId} (type=${match.type}, name=${(match as Record<string, unknown>).name})`);
                  break;
                }
              }
            }
          }
        }
      }
    }

    console.log(`[push-draft/resolve] final channelId=${channelId || '(none)'}`);

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

  return { channelId, authorId, convType };
}
