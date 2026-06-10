import { NextRequest } from 'next/server';
import pool, { initDB } from '@/lib/db';
import { frontFetch, textToHtml } from '@/lib/services/frontappService';
import { getStoreByInboxName } from '@/lib/stores';
import { cleanDraft } from '@/lib/cleanDraft';
import { callClaude } from '@/lib/services/claudeService';
import { POST as analyzePOST } from '@/app/api/plugin/analyze/route';
import { POST as pushDraftPOST } from '@/app/api/plugin/push-draft/route';
import { POST as sendMessagePOST } from '@/app/api/plugin/send-message/route';
import { POST as translatePOST } from '@/app/api/plugin/translate/route';

export interface AutoDraftResult {
  conversationId: string;
  status: 'drafted' | 'sent' | 'skipped' | 'error';
  reason?: string;
}

/** Texte lisible d'un message Front (préfère .text, sinon strip HTML de .body). */
function messageText(m: Record<string, unknown>): string {
  const t = (m.text as string) || '';
  if (t.trim()) return t.trim();
  const body = (m.body as string) || '';
  return body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Résout un teammate pour signer le commentaire interne (best-effort, mis en cache). */
let cachedAuthorId: string | null | undefined;
async function resolveCommentAuthor(): Promise<string | null> {
  if (cachedAuthorId !== undefined) return cachedAuthorId;
  try {
    const res = await frontFetch('/teammates');
    if (res.ok) {
      const data = await res.json();
      const t = (data._results || []).find((x: Record<string, unknown>) => !x.is_blocked) || (data._results || [])[0];
      cachedAuthorId = (t?.id as string) || null;
    } else {
      cachedAuthorId = null;
    }
  } catch {
    cachedAuthorId = null;
  }
  return cachedAuthorId;
}

/** Poste un commentaire interne sur la conversation (non bloquant). */
async function postComment(conversationId: string, body: string): Promise<void> {
  try {
    const authorId = await resolveCommentAuthor();
    const payload: Record<string, string> = { body };
    if (authorId) payload.author_id = authorId;
    const res = await frontFetch(`/conversations/${conversationId}/comments`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (!res.ok) console.warn(`[auto-draft] comment failed ${res.status} for ${conversationId}`);
  } catch (err) {
    console.warn('[auto-draft] comment error:', err);
  }
}

async function record(conversationId: string, storeCode: string, status: string, reason: string): Promise<void> {
  await pool.query(
    `INSERT INTO auto_drafts (conversation_id, store_code, status, reason, created_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (conversation_id) DO UPDATE SET status = $3, reason = $4, created_at = $5`,
    [conversationId, storeCode, status, reason.slice(0, 500), new Date().toISOString()]
  );
}

/**
 * Génère et pose un BROUILLON automatique pour une demande de devis (1er mail).
 * Idempotent et plein de garde-fous : ne touche jamais une conv déjà répondue,
 * déjà traitée, hors LFC, ou sans tag "Devis". Ne fait QUE des brouillons.
 */
export async function processAutoDraft(conversationId: string): Promise<AutoDraftResult> {
  await initDB();
  const skip = (reason: string): AutoDraftResult => ({ conversationId, status: 'skipped', reason });

  try {
    // 0a. Skip rapide si on a déjà tenté et échoué récemment sur cette conv.
    //     Évite de re-brûler des appels Claude + Front API à chaque poll cron sur
    //     des convs où Claude n'arrive pas à produire un brouillon valide (ex :
    //     demandes ambiguës, SAV mal-tagués). Au-delà de 12 h on re-tente
    //     (au cas où le contexte change).
    const seen = await pool.query(
      'SELECT status, created_at FROM auto_drafts WHERE conversation_id = $1',
      [conversationId]
    );
    if (seen.rows.length > 0 && seen.rows[0].status === 'error') {
      const ageMs = Date.now() - new Date(seen.rows[0].created_at).getTime();
      const ageH = ageMs / 3600000;
      if (ageH < 12) {
        return skip(`erreur récente il y a ${ageH.toFixed(1)} h — pas de retry avant 12 h`);
      }
    }

    // 0b. Pour les status='drafted' : on n'utilise PAS la table comme garde-fou
    //     (l'équipe a pu supprimer le brouillon). C'est l'état Front (hasDraft /
    //     hasReply) plus loin qui tranche.

    // 1. Conversation + tags
    const convRes = await frontFetch(`/conversations/${conversationId}`);
    if (!convRes.ok) return { conversationId, status: 'error', reason: `conv ${convRes.status}` };
    const conv = await convRes.json();
    const tags: string[] = (conv.tags || []).map((t: Record<string, unknown>) => String(t.name || '').toLowerCase());
    if (!tags.includes('devis')) return skip('pas de tag Devis');

    // 2. Inbox → boutique (v1 : LFC only)
    let inboxName = '';
    try {
      const inbRes = await frontFetch(`/conversations/${conversationId}/inboxes`);
      if (inbRes.ok) inboxName = ((await inbRes.json())._results || [])[0]?.name || '';
    } catch { /* ignore */ }
    const store = getStoreByInboxName(inboxName);
    if (!store) return skip(`inbox non mappée: "${inboxName}"`);

    // 3. Règle stricte : la conv doit contenir EXACTEMENT 1 message (le mail client).
    //    S'il y a un brouillon, une réponse, ou plusieurs entrants → c'est qu'il s'est
    //    déjà passé quelque chose → on laisse le humain s'en occuper.
    const msgsRes = await frontFetch(`/conversations/${conversationId}/messages`);
    if (!msgsRes.ok) return { conversationId, status: 'error', reason: `messages ${msgsRes.status}` };
    const msgs: Record<string, unknown>[] = (await msgsRes.json())._results || [];
    if (msgs.length !== 1) return skip(`la conv contient ${msgs.length} messages (auto-draft = 1 seul mail attendu)`);
    const sole = msgs[0];
    if (sole.is_inbound !== true) return skip('l\'unique message n\'est pas entrant');
    if (sole.is_draft === true) return skip('l\'unique message est un brouillon');
    const inbound = [sole];

    // 3a. Vérifier que c'est une vraie demande de devis.
    // Path 1 (fast, instantané) : opening line de formulaire du site → accept direct.
    // Path 2 (LLM classifier, ~1-2s) : si pas formulaire, demander à Sonnet si c'est
    //   bien une demande de devis. Couvre les mails directs (hors formulaire) où le
    //   client demande explicitement un prix/chiffrage.
    const FORM_START = /Vous avez reçu un nouveau message du formulaire|Du hast eine neue Nachricht über das Kontaktformular|Je hebt een nieuw bericht ontvangen via het contactformulier|Recibiste un mensaje nuevo desde el formulario de contacto|Hai ricevuto un nuovo messaggio dal modulo di contatto|nuovo messaggio dal modulo di contatto/i;
    const inboundBodies = inbound.map(messageText);
    const isFromForm = inboundBodies.some((b) => FORM_START.test(b.trim().slice(0, 300)));

    if (!isFromForm) {
      const fullBody = inboundBodies.join('\n\n').substring(0, 4000);
      try {
        const classifyPrompt = `Tu reçois un mail client envoyé à une boutique qui vend des FILETS DE CAMOUFLAGE, VOILES D'OMBRAGE et accessoires de fixation.

Réponds UNIQUEMENT par OUI ou NON :
- OUI = le client demande EXPLICITEMENT un devis, un prix, un chiffrage, ou des informations tarifaires sur un produit (taille, finition, couleur, quantité).
- NON = tout autre cas : complainte/SAV, suivi de commande, garantie, question générique sans demande de prix, mail de remerciement, spam, etc.

Mail :
${fullBody}`;
        const verdict = (await callClaude(
          [{ role: 'user', content: classifyPrompt }],
          { model: 'claude-sonnet-4-6', maxTokens: 10 }
        )).trim().toUpperCase();
        const wantsQuote = verdict.startsWith('OUI');
        console.log(`[auto-draft] ${conversationId} classifier verdict="${verdict.slice(0, 30)}" → ${wantsQuote ? 'accept' : 'skip'}`);
        if (!wantsQuote) {
          return skip(`classifier LLM: non-demande-de-devis (verdict="${verdict.slice(0, 20)}")`);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'classifier err';
        console.warn(`[auto-draft] ${conversationId} classifier failed: ${msg} — skip par prudence`);
        return skip(`classifier LLM error: ${msg.slice(0, 60)}`);
      }
    }

    // 4. Contexte pour analyze
    const mailContent = inboundBodies.filter(Boolean).join('\n\n---\n\n');
    if (mailContent.length < 10) return skip('contenu client vide');
    const latest = inbound[inbound.length - 1];
    const fromRec = ((latest.recipients as Record<string, unknown>[]) || []).find((r) => r.role === 'from');
    const customerEmail = (fromRec?.handle as string) || '';
    const subject = (conv.subject as string) || '';

    // 5. Pipeline analyze existant (instructions agent + docs + stock + images), non-stream
    const analyzeReq = new NextRequest('https://internal/api/plugin/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        storeCode: store.code,
        customerEmail,
        customerName: '',
        mailContent,
        frontConversationId: conversationId,
        subject,
        // Auto-draft : on part TOUJOURS d'une analyse vierge. Sinon, en cas de
        // re-traitement (brouillon supprimé par l'équipe), Claude se confond et
        // sort du méta-commentaire ("le client n'a pas répondu...").
        forceFresh: true,
      }),
    });
    const analyzeRes = await analyzePOST(analyzeReq);
    if (!analyzeRes.ok) {
      const e = await analyzeRes.text().catch(() => '');
      await record(conversationId, store.code, 'error', `analyze ${analyzeRes.status}: ${e}`);
      return { conversationId, status: 'error', reason: `analyze ${analyzeRes.status}` };
    }
    const rawDraft = await analyzeRes.text();
    if (!rawDraft || rawDraft.startsWith('__ERROR__')) {
      await record(conversationId, store.code, 'error', 'analyze a renvoyé une erreur');
      return { conversationId, status: 'error', reason: 'analyze __ERROR__' };
    }

    // 6. Nettoyage → corps mail client (sans questions ni notes internes)
    const emailText = cleanDraft(rawDraft);
    if (!emailText || emailText.length < 20) {
      await record(conversationId, store.code, 'error', 'brouillon vide après nettoyage');
      return { conversationId, status: 'error', reason: 'brouillon vide' };
    }

    // 6a. Garde-fou qualité PERMISSIF : on ne bloque que les cas franchement
    // cassés (méta-commentaire sans salutation, réponse vide ou tronquée
    // ridiculement courte). Pour TOUT le reste — y compris les mails qui
    // posent une question, demandent une vérification, ou n'ont pas la
    // clôture standard — on pose le brouillon (c'est un BROUILLON, l'équipe
    // relit avant envoi de toute façon).
    const greetingOk = /^(Bonjour|Hallo|Hola|Buongiorno|Goedendag|Beste|Dear|Hello)\b/i.test(emailText.trim());
    if (!greetingOk || emailText.length < 200) {
      const why = `mail mal formé (greeting=${greetingOk}, len=${emailText.length})`;
      console.warn(`[auto-draft] ${conversationId} ${why} — pas de pose`);
      await record(conversationId, store.code, 'error', why);
      await postComment(
        conversationId,
        '⚠️ Auto-draft Claude : la réponse générée ne ressemble pas à un mail valide (méta-commentaire ou trop courte). Aucun brouillon posé — à traiter via le plugin.'
      );
      return { conversationId, status: 'error', reason: why };
    }

    // 6b. Traduction pour les boutiques non francophones (Claude rédige toujours en FR).
    // Si la traduction échoue, on NE poste PAS : mieux vaut pas de brouillon qu'un
    // brouillon en français envoyé à un client étranger.
    let finalText = emailText;
    if (store.defaultLang && store.defaultLang !== 'fr') {
      try {
        const trReq = new NextRequest('https://internal/api/plugin/translate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: emailText, targetLanguage: store.defaultLang, mailContent }),
        });
        const trRes = await translatePOST(trReq);
        if (!trRes.ok) {
          await record(conversationId, store.code, 'error', `translate ${trRes.status}`);
          return { conversationId, status: 'error', reason: `translate ${trRes.status}` };
        }
        const tr = await trRes.json();
        if (tr.wasTranslated && tr.translatedText) finalText = tr.translatedText;
      } catch (e) {
        const m = e instanceof Error ? e.message : 'erreur';
        await record(conversationId, store.code, 'error', `translate: ${m}`);
        return { conversationId, status: 'error', reason: `translate: ${m}` };
      }
    }
    const html = textToHtml(finalText);

    // 7. Poser dans Front : auto-send OU auto-draft selon la variable d'env.
    // AUTO_SEND_ENABLED=true → envoie le mail au client direct.
    // Sinon (défaut) → crée juste un brouillon que l'équipe relit/envoie à la main.
    // Kill switch : il suffit de mettre AUTO_SEND_ENABLED=false sur Render et redeploy
    // pour rebasculer en mode brouillon, sans toucher au code.
    const sendMode = process.env.AUTO_SEND_ENABLED === 'true';

    const endpointName = sendMode ? 'send-message' : 'push-draft';
    const handler = sendMode ? sendMessagePOST : pushDraftPOST;
    const url = sendMode ? 'https://internal/api/plugin/send-message' : 'https://internal/api/plugin/push-draft';
    const handlerReq = new NextRequest(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId, body: html }),
    });
    const handlerRes = await handler(handlerReq);
    if (!handlerRes.ok) {
      const e = await handlerRes.text().catch(() => '');
      await record(conversationId, store.code, 'error', `${endpointName} ${handlerRes.status}: ${e}`);
      return { conversationId, status: 'error', reason: `${endpointName} ${handlerRes.status}` };
    }

    // 8. Idempotence + commentaire interne court pour l'agent
    const finalStatus: 'sent' | 'drafted' = sendMode ? 'sent' : 'drafted';
    await record(conversationId, store.code, finalStatus, '');
    const comment = sendMode
      ? '📤 Mail envoyé automatiquement par Claude (auto-send devis). Si la réponse n\'est pas bonne, contre-mail rapidement.'
      : '✍️ Brouillon créé automatiquement par Claude. Tout le détail est dans le plugin si besoin d\'aller vérifier.';
    await postComment(conversationId, comment);

    console.log(`[auto-draft] ${conversationId} (${store.code}) → ${sendMode ? 'ENVOYÉ' : 'brouillon posé'}`);
    return { conversationId, status: finalStatus };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'erreur inconnue';
    console.error(`[auto-draft] ${conversationId} error:`, msg);
    return { conversationId, status: 'error', reason: msg };
  }
}
