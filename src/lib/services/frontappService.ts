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
export async function getConversationImages(conversationId: string): Promise<{ data: string; mediaType: string; name: string; type: 'image' | 'pdf' }[]> {
  const images: { data: string; mediaType: string; name: string; type: 'image' | 'pdf' }[] = [];
  const imageTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  const pdfType = 'application/pdf';
  const maxImages = 10;
  const minSize = 10 * 1024; // 10KB min — exclut logos/icônes
  const maxSize = 5 * 1024 * 1024; // 5MB max
  const maxPdfSize = 30 * 1024 * 1024; // 30MB max pour les PDF

  // Dédup : la même PJ peut apparaître plusieurs fois dans un fil (signature mail
  // intégrée, citation des messages précédents, etc.) — typique d'image001.png à
  // 763 KB répétée 4× = 4 téléchargements + 4 envois Claude inutiles → bug "tourne
  // en boucle" sur conv épaisse. Clé = nom + taille, suffisamment safe en pratique.
  const seenAttachments = new Set<string>();

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
        const isPdf = contentType === pdfType || (att.filename || '').toLowerCase().endsWith('.pdf');
        if (!imageTypes.includes(contentType) && !isPdf) continue;
        // Exclure les petites images inline = quasi certainement des logos de
        // signature mail. Seuil baissé de 100 KB à 20 KB après cas Olivier Buhl
        // (cnv_1lidzetz, 09/06/2026) : les schémas dessinés par les clients via
        // Outlook/Gmail font typiquement 25-80 KB et étaient à tort éjectés.
        // Les VRAIES signatures logos font 5-20 KB (PNG 200×80 px), on les filtre.
        const attSize = att.size || 0;
        if (att.metadata?.is_inline && attSize > 0 && attSize < 20 * 1024) {
          console.log(`[frontapp] skipping small inline image ${att.filename} (${attSize} bytes, cid:${att.metadata.cid})`);
          continue;
        }
        const filename = (att.filename || '').toLowerCase();
        // Exclure les logos/signatures/bannières par nom explicite. Le pattern
        // `imageNNN.png` (Outlook) n'est PLUS filtré : trop large, il éjectait
        // aussi les schémas légitimes nommés image003.png par le client. Le
        // dedup nom+taille un peu plus bas suffit pour éviter de re-télécharger
        // une signature répétée dans le fil (cas original du 763 KB ×4).
        if (/^(logo|signature|banner|bannière|icon)/i.test(filename)) {
          console.log(`[frontapp] skipping logo/signature image: ${att.filename}`);
          continue;
        }
        // Déduplication.
        // (a) clé nom + bucket KB : tolérante à ~1 KB de différence pour les
        //     signatures réinsérées dans les citations qui ont quelques bytes
        //     EXIF/metadata qui varient (image001.png 763798 vs 763796 = même
        //     image).
        // (b) pour les PETITES images inline (< 100 KB) : clé taille EXACTE +
        //     content-type, sans le nom. Évince les logos de signature qui se
        //     déguisent en attachment-1.png / attachment-6.png / '' (cas réel
        //     cnv_1liirz6f, 12/06/2026 : 3 copies du même logo 68559 bytes sous
        //     3 noms différents prenaient des slots et polluaient l'analyse).
        //     Risque négligeable de fausse collision : 2 PNG distincts du même
        //     client à l'octet près = ~zéro.
        const sizeBucket = Math.round(attSize / 1024); // arrondi au KB
        const dedupKey = `${att.filename || ''}_${sizeBucket}`;
        const isSmallInline = att.metadata?.is_inline && attSize > 0 && attSize < 100 * 1024;
        const exactSizeKey = isSmallInline ? `__small_inline_${attSize}_${contentType}` : null;
        if (seenAttachments.has(dedupKey)) {
          console.log(`[frontapp] skipping duplicate attachment: ${att.filename} (${attSize} bytes — déjà vu, bucket=${sizeBucket}KB)`);
          continue;
        }
        if (exactSizeKey && seenAttachments.has(exactSizeKey)) {
          console.log(`[frontapp] skipping logo lookalike: ${att.filename} (${attSize} bytes exacts — même size+type qu'une image inline déjà gardée)`);
          continue;
        }
        seenAttachments.add(dedupKey);
        if (exactSizeKey) seenAttachments.add(exactSizeKey);
        const size = att.size || 0;
        if (!isPdf && size > 0 && size < minSize) {
          console.log(`[frontapp] skipping small image ${att.filename} (${size} bytes)`);
          continue;
        }
        if (!isPdf && size > maxSize) {
          console.log(`[frontapp] skipping large image ${att.filename} (${size} bytes)`);
          continue;
        }
        if (isPdf && size > maxPdfSize) {
          console.log(`[frontapp] skipping large PDF ${att.filename} (${size} bytes)`);
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
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let imgBuffer: any = Buffer.from(await attRes.arrayBuffer());

          // Détecter le VRAI type via magic bytes — Front ment souvent sur le content_type
          // (un fichier annoncé .pdf peut être corrompu, tronqué, ou en réalité une image)
          const magic = imgBuffer.slice(0, 4);
          const isRealPdf = magic[0] === 0x25 && magic[1] === 0x50 && magic[2] === 0x44 && magic[3] === 0x46; // %PDF
          const isRealImage =
            (magic[0] === 0xFF && magic[1] === 0xD8) || // JPEG
            (magic[0] === 0x89 && magic[1] === 0x50) || // PNG
            (magic[0] === 0x47 && magic[1] === 0x49) || // GIF
            (magic[0] === 0x52 && magic[1] === 0x49);   // WEBP (RIFF)

          if (isPdf && !isRealPdf && !isRealImage) {
            // Annoncé comme PDF mais octets invalides → skip plutôt que faire planter l'appel Claude
            console.warn(`[frontapp] skipping ${att.filename}: PDF invalide (magic bytes ${magic.toString('hex')})`);
            continue;
          }

          if (isRealPdf) {
            // PDF : envoyer tel quel en base64
            const base64 = imgBuffer.toString('base64');
            images.push({ data: base64, mediaType: 'application/pdf', name: att.filename || 'document.pdf', type: 'pdf' });
            console.log(`[frontapp] extracted PDF: ${att.filename} (${Math.round(imgBuffer.byteLength / 1024)}KB)`);
          } else {
            // Image (y compris un fichier annoncé .pdf mais qui est en réalité une image) :
            // vérifier taille et compresser si nécessaire
            if (imgBuffer.byteLength < minSize) {
              console.log(`[frontapp] skipping small image ${att.filename} (${imgBuffer.byteLength} bytes actual)`);
              continue;
            }
            // Détecter le vrai format (Front peut mentir sur le content_type)
            let finalMediaType = contentType;
            const header = imgBuffer.slice(0, 4);
            if (header[0] === 0xFF && header[1] === 0xD8) {
              finalMediaType = 'image/jpeg';
            } else if (header[0] === 0x89 && header[1] === 0x50) {
              finalMediaType = 'image/png';
            } else if (header[0] === 0x47 && header[1] === 0x49) {
              finalMediaType = 'image/gif';
            } else if (header[0] === 0x52 && header[1] === 0x49) {
              finalMediaType = 'image/webp';
            }
            if (finalMediaType !== contentType) {
              console.log(`[frontapp] corrected media type for ${att.filename}: ${contentType} → ${finalMediaType}`);
            }
            const maxBase64Size = 3700000;
            const maxDimension = 7500; // marge sous la limite API Claude (8000px)
            // Lire les dimensions : Claude rejette toute image > 8000px même si elle est légère
            let tooLarge = imgBuffer.byteLength > maxBase64Size;
            try {
              const meta = await sharp(imgBuffer).metadata();
              if ((meta.width || 0) > maxDimension || (meta.height || 0) > maxDimension) {
                console.log(`[frontapp] ${att.filename} dimensions ${meta.width}x${meta.height} > ${maxDimension}px → resize`);
                tooLarge = true;
              }
            } catch (metaErr) {
              console.warn(`[frontapp] metadata read failed for ${att.filename}:`, metaErr);
            }
            if (tooLarge) {
              console.log(`[frontapp] compressing ${att.filename} (${Math.round(imgBuffer.byteLength / 1024)}KB → target < 3.7MB, max 1500px)`);
              try {
                imgBuffer = await sharp(imgBuffer)
                  .resize({ width: 1500, height: 1500, fit: 'inside', withoutEnlargement: true })
                  .jpeg({ quality: 80 })
                  .toBuffer();
                finalMediaType = 'image/jpeg';
                console.log(`[frontapp] compressed to ${Math.round(imgBuffer.byteLength / 1024)}KB`);
              } catch (compressErr) {
                console.warn(`[frontapp] compression failed for ${att.filename}:`, compressErr);
                // Si on n'a pas pu réduire une image trop lourde OU trop grande, on la skip
                // plutôt que de faire planter l'appel Claude (erreur 400 dimensions/taille)
                continue;
              }
            }
            const base64 = imgBuffer.toString('base64');
            images.push({ data: base64, mediaType: finalMediaType, name: att.filename || 'image', type: 'image' });
            console.log(`[frontapp] extracted image: ${att.filename} (${finalMediaType}, ${Math.round(imgBuffer.byteLength / 1024)}KB)`);
          }
        } catch (err) {
          console.warn(`[frontapp] failed to download attachment ${att.filename}:`, err);
        }
      }
    }
  } catch (err) {
    console.warn('[frontapp] getConversationImages error:', err);
  }

  const totalB64 = images.reduce((s, im) => s + im.data.length, 0);
  console.log(`[frontapp] getConversationImages done: ${images.length} attachments, ~${Math.round(totalB64 / 1024)}KB base64 total`);
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
  // Blocs séparés par une ligne vide → un <p> chacun (un seul interligne entre eux).
  // Sauts de ligne simples dans un bloc → <br>. Évite le double interligne.
  const escapeHtml = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return text
    .split(/\n\s*\n/)
    .map((block) => {
      const trimmed = block.trim();
      if (!trimmed) return '';
      const html = trimmed.split('\n').map((line) => escapeHtml(line.trimEnd())).join('<br>');
      return `<p>${html}</p>`;
    })
    .filter(Boolean)
    .join('');
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
