import { NextRequest } from 'next/server';
import pool, { initDB } from '@/lib/db';
import { archiveConversation, frontFetch, textToHtml } from '@/lib/services/frontappService';
import { getStoreByInboxName } from '@/lib/stores';
import { cleanDraft, hasOpenQuestions } from '@/lib/cleanDraft';
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

  // 0a. Skip rapide si on a déjà tenté et échoué récemment sur cette conv.
  //     Évite de re-brûler des appels Claude + Front API à chaque poll cron sur
  //     des convs où Claude n'arrive pas à produire un brouillon valide (ex :
  //     demandes ambiguës, SAV mal-tagués). Au-delà de 12 h on re-tente
  //     (au cas où le contexte change).
  const seen = await pool.query(
    'SELECT status, created_at FROM auto_drafts WHERE conversation_id = $1',
    [conversationId]
  );
  const seenRow: { status: string; created_at: string } | null = seen.rows[0] || null;

  // `skip` log désormais TOUS les skip dans auto_drafts (sauf "erreur récente"
  // pour ne pas écraser l'entrée error qui sert au cooldown 12 h, et sauf si on
  // a déjà un succès historique 'drafted'/'sent' qu'on ne veut pas écraser).
  // Permet de diagnostiquer après coup pourquoi une conv n'a pas été traitée
  // (ex : classifier LLM a dit non à tort) sans avoir à rejouer le mail.
  const skip = async (reason: string, storeCode = ''): Promise<AutoDraftResult> => {
    const isCooldownSkip = reason.startsWith('erreur récente');
    const isHistoricalSuccess = seenRow?.status === 'drafted' || seenRow?.status === 'sent';
    if (!isCooldownSkip && !isHistoricalSuccess) {
      try {
        await record(conversationId, storeCode, 'skipped', reason);
      } catch (e) {
        console.warn('[auto-draft] record skip failed:', e);
      }
    }
    return { conversationId, status: 'skipped', reason };
  };

  try {
    if (seenRow && seenRow.status === 'error') {
      const ageMs = Date.now() - new Date(seenRow.created_at).getTime();
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
    if (!convRes.ok) {
      const why = `conv ${convRes.status}`;
      // Record les vraies erreurs (500, 502, 404, 401…) pour déclencher le
      // cooldown 12h et éviter de re-brûler la même conv à chaque poll.
      // Exception : 429 (rate-limit Front) — c'est transient (< 60s), le
      // retry-in-frontFetch gère la majorité, et pour les 429 qui échappent
      // aux 3 retries on préfère retenter au prochain poll (2 min) plutôt
      // que de mettre 12 h de cooldown et rater la fenêtre auto-draft.
      if (convRes.status !== 429) {
        await record(conversationId, '', 'error', why);
      }
      return { conversationId, status: 'error', reason: why };
    }
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
    if (!msgsRes.ok) {
      const why = `messages ${msgsRes.status}`;
      // Idem ligne 1 : record les vraies erreurs, laisse passer les 429
      // pour retry naturel au prochain poll.
      if (msgsRes.status !== 429) {
        await record(conversationId, store.code, 'error', why);
      }
      return { conversationId, status: 'error', reason: why };
    }
    const msgs: Record<string, unknown>[] = (await msgsRes.json())._results || [];
    if (msgs.length !== 1) return skip(`la conv contient ${msgs.length} messages (auto-draft = 1 seul mail attendu)`, store.code);
    const sole = msgs[0];
    if (sole.is_inbound !== true) return skip('l\'unique message n\'est pas entrant', store.code);
    if (sole.is_draft === true) return skip('l\'unique message est un brouillon', store.code);

    // Skip les notifications auto (transporteurs, bounces, no-reply). Ces mails
    // n'attendent aucune action humaine — on évite l'appel classifier + analyze
    // Sonnet qui serait gaspillé. ATTENTION : mailer@shopify.com est explicitement
    // EXCLU de la regex car c'est l'expéditeur des formulaires de contact du site
    // (= vraies demandes clients à traiter). Le check FORM_START en aval suffit
    // pour eux. Regex à enrichir au fur et à mesure si on observe d'autres patterns.
    const AUTO_SENDER_RE = /(no[-_.]?reply|noreply|mailer[-_.]?daemon|^bounces?@|mondialrelay|@laposte\.fr|chronopost|colissimo|@[^@\s]*\.myshopify\.com|notifications?@(?!shopify))/i;
    const recipients = (sole.recipients as Array<{ role?: string; handle?: string }> | undefined) || [];
    const fromRcpt = recipients.find((r) => r.role === 'from');
    const senderHandle = fromRcpt?.handle
      || ((sole.author as Record<string, unknown> | undefined)?.email as string)
      || '';
    if (senderHandle && AUTO_SENDER_RE.test(senderHandle)) {
      return skip(`auto-sender détecté (${senderHandle}) — pas d'analyse`, store.code);
    }

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
        // Prompt élargi (12/06/2026) : auparavant on exigeait une demande
        // EXPLICITE de prix → faux négatifs sur des mails type
        // « je suis intéressé par un filet 3x4 sable renforcé, quelle taille
        // dois-je commander ? » (cas Delmonthierry cnv_1lmu6qdz). On accepte
        // désormais aussi les demandes implicites (description projet +
        // dimensions + couleur/finition, question conseil taille, faisabilité).
        const classifyPrompt = `Tu reçois un mail client envoyé à une boutique qui vend des FILETS DE CAMOUFLAGE, VOILES D'OMBRAGE et accessoires de fixation.

Réponds UNIQUEMENT par OUI ou NON.

Réponds OUI si le mail contient au moins UN de ces éléments — même implicitement :
- demande explicite d'un devis, prix, chiffrage, tarif (« combien coûte… », « pouvez-vous me faire un prix… »)
- description d'un projet avec dimensions précises ET au moins une caractéristique produit (couleur, finition, matière) → c'est une demande de devis sur-mesure implicite
- question « quelle taille / quelle dimension dois-je commander pour [usage] » avec contexte produit identifié
- demande de faisabilité d'un produit avec dimensions OU couleur OU finition précisées (« est-ce possible de faire un filet 3x4 sable… »)
- intérêt explicite pour acheter un produit donné (« je suis intéressé par un filet… ») avec description du besoin

Réponds NON si le mail est :
- SAV / réclamation / défaut produit / retour / remboursement
- suivi de commande, livraison, garantie
- demande de coordonnées sans contexte produit
- remerciement, spam, mail vide
- question générique sans aucune mention de dimensions/couleur/finition/produit précis

Mail :
${fullBody}`;
        const verdict = (await callClaude(
          [{ role: 'user', content: classifyPrompt }],
          { model: 'claude-sonnet-4-6', maxTokens: 10 }
        )).trim().toUpperCase();
        const wantsQuote = verdict.startsWith('OUI');
        console.log(`[auto-draft] ${conversationId} classifier verdict="${verdict.slice(0, 30)}" → ${wantsQuote ? 'accept' : 'skip'}`);
        if (!wantsQuote) {
          return skip(`classifier LLM: non-demande-de-devis (verdict="${verdict.slice(0, 20)}")`, store.code);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'classifier err';
        console.warn(`[auto-draft] ${conversationId} classifier failed: ${msg} — skip par prudence`);
        return skip(`classifier LLM error: ${msg.slice(0, 60)}`, store.code);
      }
    }

    // 3b. Garde-fou anti-mail-mixte : si le mail contient une demande SAV /
    // retour / remboursement / échange / garantie / changement d'adresse /
    // annulation, on FORCE le mode brouillon (pas d'auto-send), même si
    // AUTO_SEND_ENABLED=true. Raison : ces sujets exigent une décision humaine,
    // l'agent ne doit JAMAIS y répondre en auto. Cas réel cnv_1lqw8h1z (LFC,
    // 29/06/2026, Mathieu PHILIPPE) : demande devis sur-mesure + retour
    // commande LFC33972 → l'agent a inventé un échange avec remboursement +
    // code promo ECHANGE15, et l'auto-send a transmis au client.
    let forceBrouillonMode = false;
    let savReason = '';

    // 3b. (Supprimé 08/07/2026) L'ancien check "premier contact client" qui
    //     appelait /conversations/search/{email} produisait des faux positifs
    //     massifs — Front's search est full-text (matche l'email dans le corps
    //     des mails, signatures, cross-refs entre inboxes admin) ET plafonne
    //     à 50 résultats par page. Résultat : 18 blocages/2 j avec exactement
    //     « 49 conv antérieures » = juste la saturation de la page de search
    //     moins la conv courante.
    //
    //     La règle métier vraie est déjà couverte par le check ligne 142 :
    //     msgs.length !== 1 → skip. Autrement dit :
    //       - Auto-send OK si la conv contient EXACTEMENT le mail entrant
    //         qui vient d'arriver et rien d'autre (peu importe que le client
    //         ait d'autres convs séparées ailleurs).
    //       - Auto-send bloqué dès qu'il y a un OUT (on a déjà répondu) OU
    //         un 2ᵉ IN (conv en cours) OU un brouillon.
    //     Cas cnv_1lseqatz (mike@die-gestalter.swiss, 06/07) qui avait motivé
    //     la règle : si la nouvelle demande arrive dans un nouveau thread
    //     séparé des factures Shopify → auto-send légitime ; si elle arrive
    //     dans le thread existant (2ᵉ IN) → bloquée par ligne 142.

    // 3c. SAV detector.
    if (!forceBrouillonMode) {
      const fullBody = inboundBodies.join('\n\n').substring(0, 4000);
      try {
        const savPrompt = `Tu reçois un mail envoyé à une boutique e-commerce de filets / voiles d'ombrage.

Réponds UNIQUEMENT par OUI ou NON.

Réponds OUI si le mail contient — EN PLUS de toute demande de devis éventuelle — au moins UN de ces sujets qui exige une décision humaine :
- retour de produit (renvoyer un article, étiquette retour, RMA, « je veux retourner »)
- remboursement (« être remboursé », « créditer », « avoir un remboursement »)
- échange (« changer pour », « échanger contre »)
- garantie, défaut produit, produit cassé / défectueux / non conforme
- réclamation SAV générale (« je ne suis pas content », « le produit ne va pas »)
- annulation de commande
- changement d'adresse de livraison / coordonnées sur une commande existante
- suivi de livraison / colis perdu / délai dépassé
- mention d'un numéro de commande déjà passée (#LFC..., commande #...) à propos d'un problème

Réponds NON si le mail ne contient AUCUN de ces sujets, OU si le mail est UNIQUEMENT une demande de devis / prix / chiffrage sur un produit (même mention de dimensions, finitions, projet).

Mail :
${fullBody}`;
        const savVerdict = (await callClaude(
          [{ role: 'user', content: savPrompt }],
          { model: 'claude-haiku-4-5-20251001', maxTokens: 10 }
        )).trim().toUpperCase();
        if (savVerdict.startsWith('OUI')) {
          forceBrouillonMode = true;
          savReason = 'mail contient un sujet SAV / retour / remboursement / échange / garantie / annulation → mode brouillon forcé (décision humaine requise)';
          console.log(`[auto-draft] ${conversationId} SAV detector verdict="${savVerdict.slice(0, 30)}" → FORCE brouillon mode`);
        } else {
          console.log(`[auto-draft] ${conversationId} SAV detector verdict="${savVerdict.slice(0, 30)}" → auto-send autorisé`);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'sav detector err';
        // Si le détecteur SAV plante, on bascule par prudence en mode brouillon
        // (mieux vaut un faux positif "trop prudent" qu'un faux négatif
        // "envoyé alors qu'il fallait pas").
        forceBrouillonMode = true;
        savReason = `SAV detector error: ${msg.slice(0, 80)} → mode brouillon forcé par prudence`;
        console.warn(`[auto-draft] ${conversationId} SAV detector failed: ${msg} — force brouillon par prudence`);
      }
    }

    // 4. Contexte pour analyze
    const mailContent = inboundBodies.filter(Boolean).join('\n\n---\n\n');
    if (mailContent.length < 10) return skip('contenu client vide', store.code);
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

    // 5b. Court-circuit PJ trop volumineuse : /analyze a renvoyé un marker
    // au lieu d'un brouillon (au moins une PJ > 22 MB PDF ou > 5 MB image →
    // dépasse la limite Anthropic 32 MB base64 par bloc). Décision humaine
    // requise via le plugin (le gérant décrit la PJ via Claude Desktop puis
    // colle la description en chat). Pas de brouillon posé, commentaire sur
    // la conv.
    if (rawDraft.startsWith('__PJ_TOO_LARGE__')) {
      let pjList: { name: string; sizeBytes: number }[] = [];
      try {
        const payload = JSON.parse(rawDraft.slice('__PJ_TOO_LARGE__'.length));
        if (Array.isArray(payload?.attachments)) pjList = payload.attachments;
      } catch { /* payload malformé — on continue avec liste vide */ }
      const pjSummary = pjList.length > 0
        ? pjList.map((a) => `${a.name} (${(a.sizeBytes / 1024 / 1024).toFixed(1)} MB)`).join(', ')
        : 'PJ non détaillée';
      const why = `PJ trop volumineuse pour l'API Anthropic : ${pjSummary} — nécessite intervention manuelle via plugin`;
      console.log(`[auto-draft] ${conversationId} ${why}`);
      await record(conversationId, store.code, 'skipped', why);
      await postComment(
        conversationId,
        `⚠️ Auto-draft Claude BLOQUÉ : ${pjSummary} — PJ trop volumineuse pour l'API. À traiter via le plugin : le bandeau orange proposera de décrire la PJ via Claude Desktop.`
      );
      return { conversationId, status: 'skipped', reason: why };
    }

    // 6. Nettoyage → corps mail client (sans questions ni notes internes)
    const emailText = cleanDraft(rawDraft);
    if (!emailText || emailText.length < 20) {
      await record(conversationId, store.code, 'error', 'brouillon vide après nettoyage');
      return { conversationId, status: 'error', reason: 'brouillon vide' };
    }

    // 6-BIS. GARDE-FOU ANTI-FUITE INTERNE (Charles 29/07/2026, cnv_1ly9eljr) :
    // même après cleanDraft, on vérifie qu'AUCUN marqueur interne n'a survécu.
    // Si oui → refus total de poser (ni auto-send, ni brouillon). Le mail est
    // à traiter manuellement via le plugin, qui a son propre découpage visuel
    // par section.
    //
    // Cas déclencheur : cnv_1ly9eljr (RED, 29/07/2026) — Claude a écrit
    // `## BROUILLON` et `## QUESTIONS` (heading H2 markdown). Le regex serveur
    // n'acceptait pas le préfixe `##` (fix client-side du #222 non porté ici),
    // donc TOUT le bloc QUESTIONS (dont "🟠 ATTENTION — Client professionnel...")
    // est parti au client en auto-send. Le fix regex ci-dessus (ligne 84+) et
    // le filet ULTIME dans cleanDraft règlent le cas connu ; ce garde-fou est
    // le dernier rempart si un futur format échappe encore aux deux.
    if (hasOpenQuestions(emailText)) {
      const why = 'marqueur interne (QUESTIONS / VÉRIFICATION / [⚠️]) a survécu à cleanDraft — refus total de poser';
      console.warn(`[auto-draft] ${conversationId} ${why}`);
      await record(conversationId, store.code, 'error', why);
      await postComment(
        conversationId,
        '⚠️ Auto-draft Claude BLOQUÉ : la réponse contient encore un marqueur interne (QUESTIONS, VÉRIFICATION, ou alerte [⚠️]) après le nettoyage. Aucun brouillon posé pour ne PAS risquer de fuiter ces notes au client — à traiter via le plugin.'
      );
      return { conversationId, status: 'error', reason: why };
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

    // 6a-bis. Garde-fou anti-prix-vides : si le brouillon contient une ligne
    // type "Total HT : €", "Surface : m²" (label prix/qté suivi de ':' puis
    // AUCUN chiffre), c'est que Claude a généré un tableau de prix sans avoir
    // les infos pour chiffrer (ou que cleanDraft a vidé des crochets type
    // "[8,40 ou 8,50]" qui contenaient des valeurs à trancher). On bloque
    // le push : mieux vaut pas de brouillon qu'un devis avec prix vides
    // envoyé au client.
    // Cas réels :
    //  - cnv_1lmrvoev (RED, 12/06/2026) : tableau ES "Total sin IVA : "
    //  - cnv_1lo2b5xz (LFC, 17/06/2026) : tableau FR "Total hors TVA : €"
    //    avec ambiguïté sur les dimensions, Claude a écrit [X ou Y],
    //    cleanDraft a viré les crochets → chiffres disparus, unités restées
    //
    // Règle : un label-prix:valeur SANS aucun chiffre dans la valeur est
    // suspect, peu importe ce qui reste (espace, unité € / m² / EUR…).
    //
    // EXCEPTION : si la valeur contient du TEXTE alphabétique intentionnel
    // (≥ 4 lettres consécutives hors unités), c'est un placeholder explicite
    // à compléter par le client — pas un prix oublié. Ex :
    //  - "N° TVA intracommunautaire : (à compléter)"  → laisser passer
    //  - "N.º de IVA intracomunitario : (a completar)" → laisser passer
    // Cf cnv_1lo7oo9j (RED, Carlos Jordan 18/06/2026) faux positif.
    const PRICE_KEYWORD_RE = /\b(total|prix|precio|prezzo|preço|preis|prijs|iva|tva|tax|vat|mwst|btw|importe|importo|gesamt|netto|brutto|subtotal|sous[\s-]?total|surface|dimensions?|quantit[éà]|montant)\b/i;
    // Mots à retirer avant de chercher du "vrai texte" : unités monétaires et de mesure
    const UNIT_TOKENS_RE = /€|EUR|USD|GBP|CHF|m²|m2|m³|m3|HT|TTC|TVA|IVA|MwSt|BTW|VAT/gi;
    const emptyPriceLines = emailText.split('\n').filter((line) => {
      const t = line.trim();
      // Format "label : valeur" — label ≤ 80 chars, valeur = reste de ligne
      const m = t.match(/^([^:\n]{1,80}):\s*(.*)$/);
      if (!m) return false;
      const label = m[1];
      const value = m[2];
      // Label doit contenir un mot-clé prix/qté/surface
      if (!PRICE_KEYWORD_RE.test(label)) return false;
      // Si valeur contient un chiffre → c'est une vraie valeur, OK
      if (/\d/.test(value)) return false;
      // Si valeur contient du texte alphabétique ≥ 4 lettres (hors unités) →
      // c'est un placeholder intentionnel (« à compléter », « a completar »,
      // « to be filled », etc.). Pas un prix oublié.
      const valueWithoutUnits = value.replace(UNIT_TOKENS_RE, '');
      if (/[a-zA-Zàâäéèêëîïôöùûüçñáéíóúü]{4,}/.test(valueWithoutUnits)) return false;
      return true;
    });
    if (emptyPriceLines.length > 0) {
      const sample = emptyPriceLines.slice(0, 3).map((l) => `« ${l.trim()} »`).join(', ');
      const why = `prix vides détectés dans le brouillon : ${sample}`;
      console.warn(`[auto-draft] ${conversationId} ${why} — pas de pose`);
      await record(conversationId, store.code, 'error', why);
      await postComment(
        conversationId,
        `⚠️ Auto-draft Claude : le brouillon contient un tableau de prix avec des champs VIDES (${sample}). Aucun brouillon posé — à traiter via le plugin pour compléter les infos manquantes (couleur, finition, etc.) avant chiffrage.`
      );
      return { conversationId, status: 'error', reason: 'empty prices in draft' };
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
    // Override : si le détecteur SAV a flaggé un sujet hors-devis dans le mail,
    // on force le mode brouillon même si AUTO_SEND_ENABLED=true.
    const envSendMode = process.env.AUTO_SEND_ENABLED === 'true';
    const sendMode = envSendMode && !forceBrouillonMode;
    if (envSendMode && forceBrouillonMode) {
      console.log(`[auto-draft] ${conversationId} auto-send DÉSACTIVÉ pour cette conv : ${savReason}`);
    }

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
    await record(conversationId, store.code, finalStatus, forceBrouillonMode ? savReason : '');
    const comment = sendMode
      ? '📤 Mail envoyé automatiquement par Claude (auto-send devis). Si la réponse n\'est pas bonne, contre-mail rapidement.'
      : forceBrouillonMode
      ? `⚠️ Brouillon créé automatiquement par Claude — auto-send BLOQUÉ : ${savReason}. Décision humaine requise avant envoi. Détail dans le plugin.`
      : '✍️ Brouillon créé automatiquement par Claude. Tout le détail est dans le plugin si besoin d\'aller vérifier.';
    await postComment(conversationId, comment);

    // 9. En mode auto-send, archiver la conv : le devis est parti, plus besoin
    // qu'elle reste dans la file. Front la rouvrira automatiquement si le
    // client répond. (En mode brouillon, on laisse ouvert — l'équipe doit la
    // traiter.)
    if (sendMode) {
      try {
        await archiveConversation(conversationId);
        console.log(`[auto-draft] ${conversationId} archivée après auto-send`);
      } catch (archiveErr) {
        const m = archiveErr instanceof Error ? archiveErr.message : 'archive failed';
        console.warn(`[auto-draft] ${conversationId} archive échouée (non bloquant):`, m);
      }
    }

    console.log(`[auto-draft] ${conversationId} (${store.code}) → ${sendMode ? 'ENVOYÉ' : 'brouillon posé'}`);
    return { conversationId, status: finalStatus };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'erreur inconnue';
    console.error(`[auto-draft] ${conversationId} error:`, msg);
    return { conversationId, status: 'error', reason: msg };
  }
}
