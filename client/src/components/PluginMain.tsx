import { useState, useEffect, useRef } from 'react';
import type { FrontSingleConversationContext } from '../providers/FrontContext';
import { detectStore } from '../hooks/useStore';
import { useClaude } from '../hooks/useClaude';
import { useConversationCache } from '../hooks/useConversationCache';
import MailPreview from './MailPreview';
import ClaudeChat from './ClaudeChat';
import DraftFinal, { usePushDraft } from './DraftFinal';
import { cleanDraft } from '../utils/cleanDraft';
import QuotePanel from './QuotePanel';
import PaymentCheckPanel from './PaymentCheckPanel';
import ErrorBoundary from './ErrorBoundary';
import LoadingState from './LoadingState';
import { isDraftReady } from '../utils/cleanDraft';

/** Prompt à copier par le gérant pour décrire une PJ trop volumineuse via Claude Desktop. */
const PJ_DESCRIBE_PROMPT = 'Décris moi l\'image pour claude api frontapp';

/** Placeholder pour les cases vides du modal "Répondre à l'agent". */
const ANSWER_DEFAULT = 'à toi de décider';

/**
 * Extrait la section QUESTIONS d'un message assistant Claude.
 * Retourne le contenu de la section (sans le titre "QUESTIONS"), ou null.
 * Le format Claude typique :
 *   ...brouillon...
 *   ---
 *   QUESTIONS
 *   1. 🔴 BLOQUANT — ...
 *   2. 🟠 ATTENTION — ...
 *   3. 🟢 INFO — ...
 */
function extractQuestionsSection(content: string): string | null {
  const m = content.match(/QUESTIONS\s*(?:GÉRANT)?\s*(?:\(.*?\))?\s*[\n\r]+([\s\S]*?)(?:\n---|\nMAIL FINAL|$)/i);
  return m ? m[1].trim() : null;
}

/**
 * Parse la section QUESTIONS en items numérotés, filtre les 🟢 INFO (pas
 * de vraie question à répondre), renumérote les items restants (BONUS
 * demande Charles 03/07/2026 : "ne garde que les vraies questions").
 * Retourne [{ num, text }] où text = corps de la question sans le préfixe
 * technique 🔴/🟠 BLOQUANT/ATTENTION —.
 */
function parseActionableQuestions(content: string): { num: number; text: string }[] {
  const section = extractQuestionsSection(content);
  if (!section) return [];
  // Split sur "\n\n1. " ou début, capturer chaque item numéroté
  const items: { num: number; text: string }[] = [];
  const itemRe = /^\s*\d+\.\s+(.+?)(?=\n\s*\d+\.\s|\n{2,}[A-ZÀ-Ü]|$)/gms;
  let match;
  while ((match = itemRe.exec(section)) !== null) {
    const rawItem = match[1].trim();
    // Skip 🟢 INFO — pas une vraie question à répondre
    if (/^🟢\s*INFO\b/i.test(rawItem)) continue;
    // Retirer le préfixe technique 🔴 BLOQUANT — / 🟠 ATTENTION — pour la
    // question posée au gérant dans le modal (plus lisible).
    const clean = rawItem
      .replace(/^(🔴|🟠)\s*(BLOQUANT|ATTENTION)\s*(?:—|-)\s*/i, '')
      .trim();
    items.push({ num: items.length + 1, text: clean });
  }
  return items;
}

/**
 * Filtre les lignes 🟢 INFO de la section QUESTIONS d'un message assistant
 * pour l'affichage dans la ClaudeChat (BONUS Charles 03/07/2026 : les
 * items "🟢 INFO — ..." n'appellent pas d'action, ils polluent la vue).
 * Renumérote les items restants (1., 2., 3.).
 */
function filterInfoFromQuestions(content: string): string {
  const section = extractQuestionsSection(content);
  if (!section) return content;
  // Rebuild QUESTIONS section without 🟢 INFO items, with renumbering
  const itemRe = /^\s*\d+\.\s+(.+?)(?=\n\s*\d+\.\s|\n{2,}[A-ZÀ-Ü]|$)/gms;
  const kept: string[] = [];
  let match;
  while ((match = itemRe.exec(section)) !== null) {
    const rawItem = match[1].trim();
    if (/^🟢\s*INFO\b/i.test(rawItem)) continue;
    kept.push(rawItem);
  }
  if (kept.length === 0) {
    // Toute la section QUESTIONS est de l'INFO → on retire la section entière
    return content.replace(/(\n---\s*\n\s*QUESTIONS\b[\s\S]*)$/i, '').trim();
  }
  const renumbered = kept.map((it, i) => `${i + 1}. ${it}`).join('\n\n');
  // Remplacer la section originale par la renumérotée
  return content.replace(
    /QUESTIONS(\s*(?:GÉRANT)?\s*(?:\(.*?\))?\s*[\n\r]+)([\s\S]*?)(?=\n---|\nMAIL FINAL|$)/i,
    (_full, header, _body) => `QUESTIONS${header}${renumbered}`,
  );
}

/** Détecte le marker de PJ trop volumineuse renvoyé par /api/plugin/analyze. */
const PJ_MARKER = '__PJ_TOO_LARGE__';

function parsePjMarker(text: string | undefined | null): { name: string; sizeBytes: number; type: 'pdf' | 'image' }[] | null {
  if (!text || !text.startsWith(PJ_MARKER)) return null;
  try {
    const payload = JSON.parse(text.slice(PJ_MARKER.length));
    const list = payload?.attachments;
    return Array.isArray(list) ? list : null;
  } catch {
    return null;
  }
}

/** Structure réelle d'un message Front SDK */
interface FrontAttachment {
  id: string;
  name: string;
  contentType: string;
  size: number;
  inlineCid?: string;
}

interface FrontMessage {
  id: string;
  date: number;
  type?: string;
  content?: { body?: string; type?: string; attachments?: FrontAttachment[] };
  author?: { name?: string; email?: string };
  replyTo?: { handle?: string; contact?: { name?: string } };
}

/** Extrait le texte brut d'un message Front SDK. Nettoie le HTML Shopify. */
function extractText(msg: FrontMessage): string {
  const html = msg.content?.body || '';
  if (!html) return '';
  return stripHtml(html);
}

/** Nettoie le HTML complet (Shopify, etc.) en texte brut propre. */
function stripHtml(html: string): string {
  let text = html;
  // 1. Supprimer les commentaires HTML
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  // 2. Supprimer les blocs <style>...</style>
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  // 3. Supprimer les blocs <script>...</script>
  text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  // 4. Supprimer les blocs <head>...</head>
  text = text.replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '');
  // 5. Convertir <br>, <p>, <div>, <tr>, <li> en sauts de ligne
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/(?:p|div|tr|li|h[1-6])>/gi, '\n');
  text = text.replace(/<(?:p|div|tr|li|h[1-6])[^>]*>/gi, '\n');
  // 6. Supprimer toutes les balises restantes
  text = text.replace(/<[^>]+>/g, '');
  // 7. Décoder les entités HTML courantes
  text = text.replace(/&nbsp;/gi, ' ');
  text = text.replace(/&amp;/gi, '&');
  text = text.replace(/&lt;/gi, '<');
  text = text.replace(/&gt;/gi, '>');
  text = text.replace(/&quot;/gi, '"');
  text = text.replace(/&#39;/gi, "'");
  // 8. Nettoyer les espaces multiples et lignes vides
  text = text.replace(/[ \t]+/g, ' ');           // espaces multiples → un seul
  text = text.replace(/\n[ \t]+/g, '\n');         // espaces en début de ligne
  text = text.replace(/[ \t]+\n/g, '\n');         // espaces en fin de ligne
  text = text.replace(/\n{3,}/g, '\n\n');         // max 2 sauts de ligne consécutifs
  return text.trim();
}

/** Extrait les vraies PJ images des messages Front (exclut logos/signatures inline) */
async function extractImages(
  messages: FrontMessage[],
  downloadFn: (messageId: string, attachmentId: string) => Promise<File | undefined>,
): Promise<{ data: string; mediaType: string; name: string }[]> {
  const images: { data: string; mediaType: string; name: string }[] = [];
  const imageTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  const maxImages = 10;
  const maxSize = 5 * 1024 * 1024; // 5MB max par image
  const minSize = 10 * 1024; // 10KB min — exclut les logos/icônes

  for (const msg of messages) {
    if (images.length >= maxImages) break;
    const attachments = msg.content?.attachments || [];
    for (const att of attachments) {
      if (images.length >= maxImages) break;
      if (!imageTypes.includes(att.contentType)) continue;
      // Exclure les logos, signatures, icônes par nom de fichier
      if (/^logo|signature|banner|bannière|icon/i.test(att.name || '')) {
        console.log(`[plugin] skipping logo/signature image: ${att.name}`);
        continue;
      }
      // Exclure les images trop petites (icônes, pixels de tracking)
      if (att.size < minSize) {
        console.log(`[plugin] skipping small image ${att.name} (${att.size} bytes, likely logo/icon)`);
        continue;
      }
      if (att.size > maxSize) {
        console.log(`[plugin] skipping large image ${att.name} (${att.size} bytes)`);
        continue;
      }
      try {
        const file = await downloadFn(msg.id, att.id);
        if (!file) continue;
        const buffer = await file.arrayBuffer();
        const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
        images.push({ data: base64, mediaType: att.contentType, name: att.name });
        console.log(`[plugin] extracted image: ${att.name} (${att.contentType}, ${Math.round(att.size / 1024)}KB)`);
      } catch (err) {
        console.warn(`[plugin] failed to download attachment ${att.name}:`, err);
      }
    }
  }
  return images;
}

/** Extrait le vrai email client (pas l'adresse Shopify/intermédiaire). */
function extractCustomerEmail(msg: FrontMessage, fallback: string): string {
  return msg.replyTo?.handle || fallback;
}

/** Extrait le vrai nom client. */
function extractCustomerName(msg: FrontMessage, fallback: string): string {
  return msg.replyTo?.contact?.name || fallback;
}

interface PluginMainProps {
  context: FrontSingleConversationContext;
}

export default function PluginMain({ context }: PluginMainProps) {
  const store = detectStore(context);
  const claude = useClaude();
  const conversationCache = useConversationCache();

  // Quand un stream termine en arrière-plan, sauver le résultat dans le cache
  claude.onBackgroundComplete.current = (bgFrontConvId, convId, messages) => {
    conversationCache.setInCache(bgFrontConvId, { conversationId: convId, messages });
    conversationCache.clearPending(bgFrontConvId);
    console.log(`[plugin] background result cached for ${bgFrontConvId}: ${messages.length} msgs`);
  };
  const [templates, setTemplates] = useState<{ id: string; name: string; summary: string; content: string; attachment_url?: string; procedure_url?: string }[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('');
  const [templateAttachmentUrl, setTemplateAttachmentUrl] = useState<string>('');
  const [showTemplateSummary, setShowTemplateSummary] = useState<string | null>(null);
  const [manualValidation, setManualValidation] = useState(false);
  const [draftInvalidated, setDraftInvalidated] = useState(false);
  const [quotePdfUrl, setQuotePdfUrl] = useState<string | null>(null);
  const [quoteNumber, setQuoteNumber] = useState<string | null>(null);
  const [_quotePennylaneUrl, setQuotePennylaneUrl] = useState<string | null>(null);
  const [quoteDraftText, setQuoteDraftText] = useState<string | null>(null);
  const [mailThread, setMailThread] = useState<string>('');
  const [showQuoteConfirm, setShowQuoteConfirm] = useState(false);
  // Modale 'envoi devis' : 'choose' = sélection du mail (3 boutons), 'consigne' = saisie d'une consigne pour Claude
  const [quoteMailMode, setQuoteMailMode] = useState<'choose' | 'consigne'>('choose');
  const [quoteClaudeConsigne, setQuoteClaudeConsigne] = useState<string>('');
  const [preAnalyzeNote, setPreAnalyzeNote] = useState<string>('');
  const [showResumePopup, setShowResumePopup] = useState(false);
  const [resumeNote, setResumeNote] = useState<string>('');
  const [showPaymentCheck, setShowPaymentCheck] = useState(false);
  // État interne du QuotePanel (idle / extracting / verify / creating /
  // done) reporté par onStateChange. Sert à masquer la sticky bar quand
  // le "masque devis PDF" est plein écran (règle Charles 03/07/2026).
  const [quotePanelState, setQuotePanelState] = useState<'idle' | 'extracting' | 'verify' | 'creating' | 'done'>('idle');
  const quotePanelActive = quotePanelState === 'verify' || quotePanelState === 'extracting' || quotePanelState === 'creating';
  // Modal "Répondre à l'agent" — permet au gérant de répondre item par item
  // aux questions posées par Claude dans la section QUESTIONS du brouillon.
  const [showAnswerModal, setShowAnswerModal] = useState(false);
  const [answerInputs, setAnswerInputs] = useState<Record<number, string>>({});
  const [answerOther, setAnswerOther] = useState('');
  // Mode "Générer devis PDF direct" depuis la page d'accueil, sans passer par
  // Analyser avec Claude. Fait apparaître QuotePanel avec claudeText vide et
  // déclenche l'extraction depuis le mailThread seul.
  const [directQuoteMode, setDirectQuoteMode] = useState(false);
  const [directQuotePending, setDirectQuotePending] = useState(false);
  const [resolvedEmail, setResolvedEmail] = useState<string>('');
  const [resolvedName, setResolvedName] = useState<string>('');
  const [pushLang, setPushLang] = useState<string>('auto');
  // Langue détectée sur le mail du client (purement informative — n'écrase
  // PAS pushLang ; sert juste à afficher un warning au push si différente
  // de la langue de la boutique).
  const [detectedLang, setDetectedLang] = useState<string | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const prevConvId = useRef<string>('');
  const justSwitchedRef = useRef<boolean>(false);
  const pushDraft = usePushDraft(context);
  const quoteClickRef = useRef<(() => void) | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const recipient = context.conversation.recipient;
  const subject = context.conversation.subject;
  const frontConvId = context.conversation.id;

  // Quand la conversation Front change → charger l'historique depuis le cache ou la BDD
  useEffect(() => {
    if (!frontConvId || frontConvId === prevConvId.current) return;
    prevConvId.current = frontConvId;
    justSwitchedRef.current = true;

    // Reset les states liés au devis et aux instructions
    setManualValidation(false);
    setDraftInvalidated(false);
    setQuoteDraftText(null);
    setShowQuoteConfirm(false);
    setPreAnalyzeNote('');
    setShowResumePopup(false);
    setSelectedTemplateId('');
    setPushLang('auto');
    setDirectQuoteMode(false);
    setDirectQuotePending(false);

    // Restaurer les infos devis depuis le cache mémoire ou la BDD
    const cachedQuote = conversationCache.getQuoteFromCache(frontConvId);
    if (cachedQuote) {
      setQuotePdfUrl(cachedQuote.pdfUrl);
      setQuoteNumber(cachedQuote.quoteNumber);
      setQuotePennylaneUrl(cachedQuote.pennylaneUrl);
    } else {
      setQuotePdfUrl(null);
      setQuoteNumber(null);
      setQuotePennylaneUrl(null);
      // Fallback : charger depuis la BDD
      if (store) {
        fetch(`${window.location.origin}/api/plugin/quote-history?front_conversation_id=${encodeURIComponent(frontConvId)}&store_code=${encodeURIComponent(store.code)}`)
          .then((r) => r.json())
          .then((data) => {
            if (data && data.quote_number && frontConvId === prevConvId.current) {
              setQuoteNumber(data.quote_number);
              setQuotePennylaneUrl(data.pennylane_url || null);
              setQuotePdfUrl(data.pdf_url || null);
              conversationCache.setQuoteInCache(frontConvId, {
                pdfUrl: data.pdf_url || '', quoteNumber: data.quote_number, pennylaneUrl: data.pennylane_url || '',
              });
            }
          })
          .catch(() => {});
      }
    }

    // Résoudre l'email/nom client depuis le SDK (replyTo.handle) à chaque conversation
    (async () => {
      try {
        const msgsRes = await context.listMessages();
        const msgs = msgsRes.results as unknown as FrontMessage[];
        const firstIncoming = msgs.find((m) => m.replyTo?.handle);
        const email = extractCustomerEmail(firstIncoming || msgs[0], recipient?.handle || '');
        const name = extractCustomerName(firstIncoming || msgs[0], recipient?.name || '');
        console.log('[plugin] resolved email from replyTo:', email);
        setResolvedEmail(email);
        setResolvedName(name);
      } catch { /* fallback aux valeurs du recipient */ }
    })();

    // 1. Vérifier le cache mémoire
    const cached = conversationCache.getFromCache(frontConvId);
    if (cached) {
      console.log(`[plugin] cache hit for ${frontConvId}: ${cached.messages.length} msgs`);
      claude.restore(cached.messages, cached.conversationId, frontConvId);
      return;
    }

    // 2. Charger depuis la BDD
    if (!store) return;
    setLoadingHistory(true);
    conversationCache.loadFromDB(frontConvId, store.code).then((result) => {
      if (result && frontConvId === prevConvId.current) {
        console.log(`[plugin] DB hit for ${frontConvId}: ${result.messages.length} msgs`);
        claude.restore(result.messages, result.conversationId, frontConvId);
      } else if (frontConvId === prevConvId.current) {
        // Pas d'historique → reset
        claude.reset(frontConvId);
      }
      setLoadingHistory(false);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frontConvId, store?.code]);

  // Sauvegarder dans le cache quand les messages changent
  // IMPORTANT : ne pas écraser le cache avec un tableau vide (arrive lors du changement de conv)
  // IMPORTANT : ne pas sauver juste après un switch de conversation (les messages sont encore ceux de l'ancien mail)
  useEffect(() => {
    if (justSwitchedRef.current) {
      justSwitchedRef.current = false;
      return;
    }
    if (claude.messages.length > 0 && claude.conversationId && frontConvId && frontConvId === prevConvId.current) {
      conversationCache.setInCache(frontConvId, {
        conversationId: claude.conversationId,
        messages: claude.messages,
      });
      conversationCache.clearPending(frontConvId);
    }
  }, [claude.messages, claude.conversationId, frontConvId, conversationCache]);

  if (!store) {
    return (
      <div className="plugin-empty">
        <p>Boutique non reconnue pour cette inbox.</p>
      </div>
    );
  }

  async function handleAnalyze(noteOverride?: string, skipOversizedCheck?: boolean) {
    console.log('[plugin] handleAnalyze called', { skipOversizedCheck });
    conversationCache.setPending(frontConvId);
    console.log('[plugin] store:', store);
    console.log('[plugin] context.conversation:', context.conversation);

    try {
      // Récupérer les messages du fil via le SDK Front
      console.log('[plugin] calling context.listMessages()...');
      const messagesResponse = await context.listMessages();
      console.log('[plugin] listMessages response:', messagesResponse);
      const messages = messagesResponse.results;

      if (!messages || messages.length === 0) {
        console.warn('[plugin] No messages found in conversation');
        claude.clearError();
        return;
      }

      console.log(`[plugin] ${messages.length} messages found`);
      // Log la structure complète du premier message pour comprendre le SDK
      if (messages[0]) {
        try {
          console.log('[plugin] full message:', JSON.stringify(messages[0], null, 2));
        } catch {
          console.log('[plugin] message (non-serializable), keys:', Object.keys(messages[0]));
          for (const key of Object.keys(messages[0])) {
            const val = (messages[0] as Record<string, unknown>)[key];
            console.log(`[plugin]   ${key}: (${typeof val})`, typeof val === 'string' ? val.substring(0, 100) : val);
          }
        }
      }

      // Cast les messages vers la structure réelle du SDK
      const frontMessages = messages as unknown as FrontMessage[];

      // Extraire le vrai email/nom client depuis le premier message entrant
      const firstIncoming = frontMessages.find((m) => m.replyTo?.handle);
      const customerEmail = extractCustomerEmail(
        firstIncoming || frontMessages[0],
        recipient?.handle || ''
      );
      const customerName = extractCustomerName(
        firstIncoming || frontMessages[0],
        recipient?.name || ''
      );

      // Formater le fil de mails
      const mailContent = frontMessages
        .map((msg) => {
          const author = msg.author?.name || msg.author?.email || 'Inconnu';
          const date = new Date(msg.date * 1000).toLocaleString('fr-FR');
          const text = extractText(msg);
          return text ? `[${date}] ${author} :\n${text}` : '';
        })
        .filter(Boolean)
        .join('\n\n---\n\n');

      // Ajouter les instructions du gérant si fournies
      const note = noteOverride !== undefined ? noteOverride : preAnalyzeNote;
      const finalMailContent = note
        ? `[INSTRUCTIONS DU GÉRANT : ${note}]\n\n${mailContent}`
        : mailContent;

      // Extraire les images des PJ
      let images: { data: string; mediaType: string; name: string }[] = [];
      try {
        images = await extractImages(
          frontMessages,
          (msgId, attId) => context.downloadAttachment(msgId, attId),
        );
        if (images.length > 0) {
          console.log(`[plugin] ${images.length} images extracted from attachments`);
        }
      } catch (err) {
        console.warn('[plugin] image extraction failed, continuing without images:', err);
      }

      // Détecter le canal (chat vs email) depuis le type des messages
      const isChat = frontMessages.some((m) => m.type === 'front_chat' || m.type === 'custom');

      const payload = {
        storeCode: store!.code,
        customerEmail,
        customerName,
        mailContent: finalMailContent,
        frontConversationId: context.conversation.id,
        subject,
        channel: isChat ? 'chat' : 'email',
        images: images.length > 0 ? images : undefined,
        skipOversizedCheck: skipOversizedCheck || undefined,
      };
      console.log('[plugin] payload preview:', {
        storeCode: payload.storeCode,
        customerEmail: payload.customerEmail,
        customerName: payload.customerName,
        mailContentLength: payload.mailContent.length,
        mailContentPreview: payload.mailContent.substring(0, 200),
        frontConversationId: payload.frontConversationId,
      });

      // Stocker le fil de mails et le vrai email/nom client pour le QuotePanel
      setMailThread(mailContent);
      setResolvedEmail(customerEmail);
      setResolvedName(customerName);

      await claude.analyze(payload);
    } catch (err) {
      console.error('[plugin] handleAnalyze error:', err);
      // Remonter l'erreur à l'UI au lieu de l'avaler
      claude.setError(err instanceof Error ? err.message : 'Erreur lors de la récupération des messages');
    }
  }

  /**
   * "Générer devis PDF" direct depuis la page d'accueil : charge le fil de
   * mails via le SDK Front, force QuotePanel à s'afficher avec claudeText
   * vide, et déclenche l'extraction (qui tournera sur mailThread seul).
   */
  async function handleDirectQuote() {
    console.log('[plugin] handleDirectQuote called');
    try {
      const messagesResponse = await context.listMessages();
      const messages = messagesResponse.results;
      if (!messages || messages.length === 0) {
        claude.setError('Aucun message dans cette conversation.');
        return;
      }
      const frontMessages = messages as unknown as FrontMessage[];
      const firstIncoming = frontMessages.find((m) => m.replyTo?.handle);
      const customerEmail = extractCustomerEmail(firstIncoming || frontMessages[0], recipient?.handle || '');
      const customerName = extractCustomerName(firstIncoming || frontMessages[0], recipient?.name || '');
      const builtMailThread = frontMessages
        .map((msg) => {
          const author = msg.author?.name || msg.author?.email || 'Inconnu';
          const date = new Date(msg.date * 1000).toLocaleString('fr-FR');
          const text = extractText(msg);
          return text ? `[${date}] ${author} :\n${text}` : '';
        })
        .filter(Boolean)
        .join('\n\n---\n\n');
      setMailThread(builtMailThread);
      setResolvedEmail(customerEmail);
      setResolvedName(customerName);
      setDirectQuoteMode(true);
      setDirectQuotePending(true);
    } catch (err) {
      console.error('[plugin] handleDirectQuote error:', err);
      claude.setError(err instanceof Error ? err.message : 'Erreur lors du chargement du fil');
    }
  }

  function getTemplateInstruction(): string {
    if (!selectedTemplateId) return '';
    const tpl = templates.find((t) => t.id === selectedTemplateId);
    if (!tpl) return '';
    return `[INSTRUCTION : Applique le template "${tpl.name}" ci-dessous. Adapte-le au contexte du mail du client (nom, n° commande, détails). Rédige le brouillon en suivant la structure du template.]\n\n${tpl.content}`;
  }

  function handleAnalyzeWithTemplate() {
    const templateInstr = getTemplateInstruction();
    const userNote = preAnalyzeNote.trim();
    const combined = [templateInstr, userNote].filter(Boolean).join('\n\n');

    // Sauver l'URL de la PJ si le template en a une
    const tpl = templates.find((t) => t.id === selectedTemplateId);
    if (tpl?.attachment_url) {
      setTemplateAttachmentUrl(tpl.attachment_url);
    }

    if (hasMessages) {
      // Conversation en cours → envoyer comme message
      setManualValidation(false);
      setDraftInvalidated(true);
      if (combined) {
        claude.sendMessage(combined);
      }
    } else {
      // Pas encore d'analyse → lancer l'analyse
      handleAnalyze(combined || undefined);
    }
    setSelectedTemplateId('');
  }

  // Détecter le court-circuit PJ trop volumineuse (renvoyé par /analyze quand
  // une PJ > 22 MB PDF ou > 5 MB image est présente). Le marker peut arriver
  // soit dans le streamingContent (temps réel) soit dans le premier message
  // assistant (après stream ou après restore depuis cache).
  const pjTooLargeFromStream = parsePjMarker(claude.streamingContent);
  const pjTooLargeFromMsg = parsePjMarker(claude.messages.find((m) => m.role === 'assistant')?.content);
  const pjTooLarge = pjTooLargeFromStream || pjTooLargeFromMsg;

  // Messages exposés à ClaudeChat et à toute la logique brouillon :
  //  - on filtre le message marker PJ trop volumineuse
  //  - on épure les lignes 🟢 INFO de la section QUESTIONS des messages
  //    assistant (BONUS Charles 03/07/2026 : "ne garde dans la partie
  //    question que les vrais questions"). Renumérote les items restants.
  const visibleMessages = (pjTooLargeFromMsg
    ? claude.messages.filter((m) => !parsePjMarker(m.content))
    : claude.messages
  ).map((m) => m.role === 'assistant'
    ? { ...m, content: filterInfoFromQuestions(m.content) }
    : m
  );

  // État initial : pas encore d'analyse
  const hasMessages = visibleMessages.length > 0;

  // Détecter si le brouillon est prêt
  // RÈGLE STRICTE : le bloc vert n'apparaît JAMAIS si Claude a des questions en attente
  // sauf si l'utilisateur clique manuellement "Valider le brouillon"
  const lastAssistantMsg = [...visibleMessages].reverse().find((m) => m.role === 'assistant');
  // hasDraft accepte aussi quoteDraftText : utilisé par le mail devis ET par
  // le panel "Vérifier virement reçu" pour injecter un brouillon préparé sans
  // nouveau passage par Claude.
  const hasDraft = ((quoteDraftText?.includes('Bonjour')) || lastAssistantMsg?.content.includes('Bonjour')) ?? false;
  // Questions actionnables (🔴/🟠 uniquement, hors 🟢 INFO) extraites du
  // dernier brouillon Claude. Sert au bouton "💬 Répondre à l'agent".
  const actionableQuestions = lastAssistantMsg ? parseActionableQuestions(lastAssistantMsg.content) : [];
  // Un quoteDraftText injecté est considéré comme prêt d'office (passé par
  // le flow QuotePanel ou PaymentCheckPanel — pas besoin de relire un msg
  // Claude pour décider).
  const autoReady = !!quoteDraftText || (lastAssistantMsg ? isDraftReady(lastAssistantMsg.content) : false);
  const showDraft = !claude.isStreaming && hasDraft && (autoReady || manualValidation) && !draftInvalidated;

  // QuotePanel visible dès qu'il y a au moins un message Claude
  const showQuotePanel = hasMessages && !claude.isStreaming;

  // Direct mode : quand le gérant clique "Générer devis PDF" depuis la page
  // d'accueil, on force QuotePanel à s'afficher et on déclenche son
  // handleClick une fois monté (registerClick expose la fonction via
  // quoteClickRef). Le pending est retry à intervalle court car
  // onRegisterClick s'appelle après un re-render — pas garanti au 1er tick.
  useEffect(() => {
    if (!directQuotePending) return;
    let attempts = 0;
    const tick = () => {
      if (quoteClickRef.current) {
        quoteClickRef.current();
        setDirectQuotePending(false);
      } else if (attempts++ < 20) {
        setTimeout(tick, 50);
      } else {
        console.warn('[plugin] directQuote: quoteClickRef never became available');
        setDirectQuotePending(false);
      }
    };
    tick();
  }, [directQuotePending]);

  // Politique langue : pushLang est INITIALISÉ avec la langue de la boutique
  // (prévisible, conforme à la config du shop). La détection sur le mail du
  // client tourne en parallèle uniquement pour signaler un mismatch au push.
  useEffect(() => {
    if (!store) return;
    const storeLangMap: Record<string, string> = {
      LFC: 'fr', LVO: 'fr', COCO: 'fr', MON: 'fr', UNI: 'fr',
      TAR: 'de', HET: 'nl', RED: 'es', REDE: 'pt', RETE: 'it',
    };
    const shopLang = storeLangMap[store.code] || 'fr';
    setPushLang(shopLang);
    setDetectedLang(null);

    // Détection en arrière-plan : ne change pas pushLang, alimente juste
    // detectedLang pour l'éventuel warning au push.
    (async () => {
      try {
        const msgsRes = await context.listMessages();
        const msgs = msgsRes.results as unknown as { content?: { body?: string }; is_inbound?: boolean }[];
        const lastInbound = msgs.find((m) => m.is_inbound);
        if (!lastInbound?.content?.body) return;
        const bodyText = lastInbound.content.body
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .substring(0, 2500);
        if (!bodyText) return;
        const res = await fetch(`${window.location.origin}/api/plugin/translate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ detectOnly: true, mailContent: bodyText }),
        });
        if (res.ok) {
          const data = await res.json();
          if (data?.detectedLanguage) {
            setDetectedLang(data.detectedLanguage);
            console.log(`[plugin] detected client lang: ${data.detectedLanguage} (shop default: ${shopLang})`);
          }
        }
      } catch { /* silencieux : on garde shopLang sans warning */ }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store?.code, frontConvId]);

  // Charger les templates au montage
  useEffect(() => {
    if (!store) return;
    fetch(`${window.location.origin}/api/plugin/templates?store_code=${encodeURIComponent(store.code)}`)
      .then((r) => r.ok ? r.json() : [])
      .then((data) => { if (Array.isArray(data)) setTemplates(data); })
      .catch(() => {});
  }, [store?.code]);

  // Auto-scroll vers le bas quand du contenu change
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [claude.messages, claude.streamingContent, showDraft, manualValidation, draftInvalidated, quotePdfUrl]);

  // Auto-scroll quand le DOM change dans la zone scrollable (ex: QuotePanel ouvre un formulaire)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new MutationObserver(() => {
      setTimeout(() => { el.scrollTop = el.scrollHeight; }, 50);
    });
    observer.observe(el, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  return (
    <div className="plugin-shell">
      {/* Zone scrollable */}
      <div className="plugin-scroll" ref={scrollRef}>
        <MailPreview
          storeCode={store.code}
          customerName={recipient?.name || ''}
          customerEmail={recipient?.handle || ''}
          subject={subject}
        />

      {/* Template selector — toujours visible */}
      {templates.length > 0 && !claude.isStreaming && (
        <div style={{ padding: '6px 0' }}>
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
            <select
              value={selectedTemplateId}
              onChange={(e) => setSelectedTemplateId(e.target.value)}
              style={{ flex: 1, padding: '6px 8px', fontSize: '12px', border: '2px solid #4a90d9', borderRadius: '6px', background: '#f0f7ff', color: '#2c5282', fontWeight: 500 }}
            >
              <option value="">Aucun template</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
            <button
              onClick={() => {
                if (selectedTemplateId) {
                  const tpl = templates.find((t) => t.id === selectedTemplateId);
                  if (tpl) setShowTemplateSummary(tpl.summary);
                } else {
                  setShowTemplateSummary(templates.map((t) => `${t.name} : ${t.summary}`).join('\n\n'));
                }
              }}
              style={{ padding: '4px 10px', fontSize: '12px', border: '1px solid #ddd', borderRadius: '6px', background: 'white', cursor: 'pointer', color: '#000', fontWeight: 600 }}
            >
              i
            </button>
          </div>
          {/* Liens PJ + procédure si template sélectionné */}
          {selectedTemplateId && (() => {
            const tpl = templates.find((t) => t.id === selectedTemplateId);
            if (!tpl || (!tpl.attachment_url && !tpl.procedure_url)) return null;
            return (
              <div style={{ display: 'flex', gap: '10px', marginTop: '4px', fontSize: '11px' }}>
                {tpl.procedure_url && (
                  <a href={tpl.procedure_url} target="_blank" rel="noopener noreferrer" style={{ color: '#4a90d9', textDecoration: 'none' }}>
                    Voir la procédure
                  </a>
                )}
                {tpl.attachment_url && (
                  <span style={{ color: '#38a169' }}>PJ auto : attestation jointe au push</span>
                )}
              </div>
            );
          })()}
        </div>
      )}

      {claude.error && (
        <div className="plugin-error">
          <p>{claude.error}</p>
          <button onClick={claude.clearError}>Fermer</button>
        </div>
      )}

      {loadingHistory && (
        <LoadingState message="Chargement de l'historique..." />
      )}

      {!hasMessages && !pjTooLarge && !claude.isStreaming && !loadingHistory && conversationCache.isPending(frontConvId) && (
        <LoadingState message="Analyse en cours sur ce mail..." />
      )}

      {/* Page d'accueil : masquée aussi si un brouillon a été injecté via
          PaymentCheckPanel (le bloc DraftFinal s'affiche à la place). */}
      {!hasMessages && !claude.isStreaming && !loadingHistory && !conversationCache.isPending(frontConvId) && !quoteDraftText && !directQuoteMode && (
        <div className="plugin-actions">
          <textarea
            value={preAnalyzeNote}
            onChange={(e) => setPreAnalyzeNote(e.target.value)}
            placeholder="Instructions pour Claude (optionnel) : ex. propose un avoir, le client est pressé..."
            style={{
              width: '100%', minHeight: '50px', maxHeight: '120px', padding: '8px', fontSize: '12px',
              border: '1px solid #ddd', borderRadius: '6px', resize: 'vertical', marginBottom: '8px',
              fontFamily: 'inherit',
            }}
          />
          <button className="btn-primary" onClick={() => handleAnalyzeWithTemplate()}>
            Analyser avec Claude
          </button>

          {/* Bouton "Générer devis PDF" direct — sans passer par l'analyse
              Claude. Utile quand le gérant sait déjà ce qu'il veut générer
              (contexte simple, chiffrage déjà présent dans un mail antérieur)
              et veut sauter l'étape analyse. QuotePanel s'ouvre avec
              claudeText vide, l'extraction se fait sur mailThread seul.
              Couleur : btn-quote (vert Pennylane, même que sticky bar). */}
          <button
            className="btn-quote"
            style={{ marginTop: '6px' }}
            onClick={() => handleDirectQuote()}
          >
            📄 Générer devis PDF
          </button>

          {/* Bouton "Vérifier virement reçu" — toujours visible en page
              d'accueil. Le panel propose la saisie manuelle du n° de devis
              si la conv n'en a pas en BDD (cas devis créé hors plugin).
              Couleur : btn-payment (violet, distinct navy analyser + vert
              devis, même sur sticky bar). */}
          <button
            className="btn-payment"
            style={{ marginTop: '6px' }}
            onClick={() => setShowPaymentCheck(true)}
          >
            💳 Vérifier virement reçu
          </button>
        </div>
      )}

      {!hasMessages && claude.isStreaming && !claude.streamingContent && (
        <LoadingState progressive />
      )}

      {/* Bandeau orange : PJ trop volumineuse pour l'API Anthropic (> 22 MB
          PDF ou > 5 MB image). Le gérant a 2 choix :
          - Décrire la PJ via Claude Desktop (flow détaillé — nécessaire quand
            le contenu de la PJ est indispensable au chiffrage).
          - Ignorer la PJ (bypass — quand la question client ne dépend pas
            de la PJ, ex : suivi paiement, adresse, délai). Relance /analyze
            avec skipOversizedCheck=true, Claude tourne sur le texte + PJ
            légères, la lourde reste absente du prompt. */}
      {pjTooLarge && pjTooLarge.length > 0 && (
        <div
          style={{
            margin: '8px 0',
            padding: '12px',
            background: '#fff4e5',
            border: '2px solid #ff9800',
            borderRadius: '8px',
            fontSize: '12px',
            color: '#3d2600',
          }}
        >
          <div style={{ fontWeight: 700, fontSize: '13px', marginBottom: '6px' }}>
            ⚠️ PJ trop volumineuse pour Claude API
          </div>
          <div style={{ marginBottom: '8px' }}>
            {pjTooLarge.map((a) => (
              <div key={a.name} style={{ fontFamily: 'monospace', fontSize: '11px' }}>
                • {a.name} ({(a.sizeBytes / 1024 / 1024).toFixed(1)} MB)
              </div>
            ))}
          </div>
          <div style={{ fontWeight: 600, marginBottom: '6px' }}>Comment veux-tu procéder ?</div>
          <div style={{ display: 'flex', gap: '6px', marginBottom: '10px', flexWrap: 'wrap' }}>
            <button
              onClick={() => {
                claude.reset(frontConvId);
                handleAnalyze(undefined, true);
              }}
              style={{
                flex: '1 1 45%',
                padding: '8px 10px',
                background: 'white',
                color: '#3d2600',
                border: '1px solid #ff9800',
                borderRadius: '4px',
                fontSize: '11px',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              🚫 Ignorer la PJ, analyser sans
            </button>
            <button
              onClick={() => { /* No-op : c'est le flow actuel — le gérant copie et colle en chat. */ }}
              disabled
              style={{
                flex: '1 1 45%',
                padding: '8px 10px',
                background: '#ff9800',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                fontSize: '11px',
                fontWeight: 600,
                cursor: 'default',
              }}
            >
              📋 Décrire via Claude Desktop ↓
            </button>
          </div>
          <div style={{ marginBottom: '8px' }}>
            Ouvre l'app <strong>Claude Desktop</strong>, glisse-y la PJ avec ce prompt :
          </div>
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center', marginBottom: '8px' }}>
            <input
              type="text"
              readOnly
              value={PJ_DESCRIBE_PROMPT}
              onFocus={(e) => e.currentTarget.select()}
              onClick={(e) => e.currentTarget.select()}
              style={{
                flex: 1,
                padding: '6px 8px',
                background: 'white',
                border: '1px solid #ddd',
                borderRadius: '4px',
                fontSize: '11px',
                fontFamily: 'monospace',
                color: '#000',
              }}
            />
            <button
              onClick={(e) => {
                const btn = e.currentTarget;
                const input = btn.previousElementSibling as HTMLInputElement | null;
                if (input) {
                  input.focus();
                  input.select();
                }
                const done = (ok: boolean) => {
                  btn.textContent = ok ? '✅ Copié' : '⌘+C pour copier';
                  setTimeout(() => { btn.textContent = '📋 Copier'; }, 2000);
                };
                if (navigator.clipboard?.writeText) {
                  navigator.clipboard.writeText(PJ_DESCRIBE_PROMPT).then(() => done(true)).catch(() => {
                    try { done(document.execCommand('copy')); }
                    catch { done(false); }
                  });
                } else {
                  try { done(document.execCommand('copy')); }
                  catch { done(false); }
                }
              }}
              style={{
                padding: '6px 10px',
                background: '#ff9800',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                fontSize: '11px',
                fontWeight: 600,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              📋 Copier
            </button>
          </div>
          <div style={{ fontSize: '11px', fontStyle: 'italic' }}>
            Colle ensuite la description que Claude Desktop te renvoie dans le chat ci-dessous — l'agent reprendra l'analyse avec ce contexte.
          </div>
        </div>
      )}

      {(hasMessages || pjTooLarge || (claude.streamingContent && !parsePjMarker(claude.streamingContent))) && (
        <ClaudeChat
          messages={visibleMessages}
          streamingContent={parsePjMarker(claude.streamingContent) ? '' : claude.streamingContent}
          isStreaming={claude.isStreaming}
          onSend={claude.sendMessage}
        />
      )}

      {/* Texte brouillon validé (fond vert) — dans la zone scrollable.
          Peut s'afficher avec OU sans message Claude existant : si on a
          un quoteDraftText (injecté par QuotePanel ou PaymentCheckPanel),
          on l'utilise directement même si Claude n'a jamais analysé la
          conv (cas typique : clic "Vérifier virement reçu" depuis la
          page d'accueil sans Analyser au préalable). */}
      {showDraft && (quoteDraftText || lastAssistantMsg) && (
        <DraftFinal
          rawContent={quoteDraftText || lastAssistantMsg!.content}
          context={context}
          pdfUrl={quotePdfUrl || undefined}
          quoteNumber={quoteNumber || undefined}
          skipClean={!!quoteDraftText}
          pushError={pushDraft.pushError}
          pushSuccess={pushDraft.pushSuccess}
        />
      )}

      {/* QuotePanel (toujours disponible pour régénérer un devis).
          Rendu aussi en directQuoteMode (clic "Générer devis PDF" depuis la
          page d'accueil sans analyse Claude préalable) : claudeText est vide,
          extract-quote tourne sur mailThread seul. */}
      {((showQuotePanel && lastAssistantMsg) || directQuoteMode) && (
        <ErrorBoundary>
          <QuotePanel
            claudeText={claude.messages.filter(m => m.role === 'assistant').map(m => m.content).join('\n\n---\n\n')}
            mailThread={mailThread}
            customerEmail={resolvedEmail || recipient?.handle || ''}
            customerName={resolvedName || recipient?.name || ''}
            storeCode={store.code}
            inboxName={store.inboxName}
            frontConversationId={frontConvId}
            onSendMessage={claude.sendMessage}
            onListMessages={() => context.listMessages()}
            onRegisterClick={(fn) => { quoteClickRef.current = fn; }}
            onStateChange={setQuotePanelState}
            onQuoteCreated={(pdfUrl, qNumber, pennylaneUrl, totalTTC) => {
              setQuotePdfUrl(pdfUrl);
              setQuoteNumber(qNumber);
              setQuotePennylaneUrl(pennylaneUrl);
              setManualValidation(true);
              setDraftInvalidated(false);
              // Sauvegarder dans le cache pour persistance
              conversationCache.setQuoteInCache(frontConvId, { pdfUrl, quoteNumber: qNumber, pennylaneUrl });
              // Persister en BDD pour retrouver le devis plus tard.
              // `amount` (TTC) sert au scoring "montant exact" dans le panel virement.
              fetch(`${window.location.origin}/api/plugin/quote-history`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  frontConversationId: frontConvId,
                  storeCode: store?.code,
                  quoteNumber: qNumber,
                  pennylaneUrl,
                  pdfUrl,
                  amount: totalTTC.toFixed(2),
                }),
              }).catch(() => {});
              // Demander si on remplace le brouillon par le mail générique devis
              setQuoteMailMode('choose');
              setQuoteClaudeConsigne('');
              setShowQuoteConfirm(true);
            }}
          />
        </ErrorBoundary>
      )}

      {/* Popup confirmation remplacement brouillon par mail devis */}
      {/* Popup "Reprendre avec Claude" avec instructions optionnelles */}
      {showResumePopup && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
        }}>
          <div style={{
            background: 'white', borderRadius: '12px', padding: '20px', maxWidth: '320px', width: '90%',
            boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
          }}>
            <p style={{ fontSize: '14px', marginBottom: '12px', fontWeight: 600 }}>
              Reprendre avec Claude
            </p>
            {templates.length > 0 && (<>
              <div style={{ display: 'flex', gap: '6px', alignItems: 'center', marginBottom: '4px' }}>
                <select
                  value={selectedTemplateId}
                  onChange={(e) => setSelectedTemplateId(e.target.value)}
                  style={{ flex: 1, padding: '6px 8px', fontSize: '12px', border: '2px solid #4a90d9', borderRadius: '6px', background: '#f0f7ff', color: '#2c5282', fontWeight: 500 }}
                >
                  <option value="">Aucun template</option>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
                <button
                  onClick={() => {
                    if (selectedTemplateId) {
                      const tpl = templates.find((t) => t.id === selectedTemplateId);
                      if (tpl) setShowTemplateSummary(tpl.summary);
                    } else {
                      setShowTemplateSummary(templates.map((t) => `${t.name} : ${t.summary}`).join('\n\n'));
                    }
                  }}
                  style={{ padding: '4px 10px', fontSize: '12px', border: '1px solid #ddd', borderRadius: '6px', background: 'white', cursor: 'pointer', color: '#000', fontWeight: 600 }}
                >
                  i
                </button>
              </div>
              {selectedTemplateId && (() => {
                const tpl = templates.find((t) => t.id === selectedTemplateId);
                if (!tpl || (!tpl.attachment_url && !tpl.procedure_url)) return null;
                return (
                  <div style={{ display: 'flex', gap: '10px', marginBottom: '8px', fontSize: '11px' }}>
                    {tpl.procedure_url && (
                      <a href={tpl.procedure_url} target="_blank" rel="noopener noreferrer" style={{ color: '#4a90d9', textDecoration: 'none' }}>
                        Voir la procédure
                      </a>
                    )}
                    {tpl.attachment_url && (
                      <span style={{ color: '#38a169' }}>PJ auto jointe au push</span>
                    )}
                  </div>
                );
              })()}
            </>)}
            <textarea
              value={resumeNote}
              onChange={(e) => setResumeNote(e.target.value)}
              placeholder="Instructions pour Claude (optionnel) : ex. propose un avoir, le client est pressé, fais le devis directement..."
              style={{
                width: '100%', minHeight: '70px', maxHeight: '150px', padding: '8px', fontSize: '12px',
                border: '1px solid #ddd', borderRadius: '6px', resize: 'vertical', marginBottom: '12px',
                fontFamily: 'inherit',
              }}
            />
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                className="btn-outline"
                style={{ flex: 1 }}
                onClick={() => setShowResumePopup(false)}
              >
                Annuler
              </button>
              <button
                className="btn-primary"
                style={{ flex: 1 }}
                onClick={async () => {
                  setShowResumePopup(false);
                  setManualValidation(false);
                  setDraftInvalidated(true);
                  setQuoteDraftText(null);
                  setShowQuoteConfirm(false);
                  setQuotePdfUrl(null);
                  setQuoteNumber(null);
                  // Sauver l'URL PJ du template AVANT de reset
                  const tplForAttach = templates.find((t) => t.id === selectedTemplateId);
                  setTemplateAttachmentUrl(tplForAttach?.attachment_url || '');
                  const templateInstr = getTemplateInstruction();
                  const combined = [templateInstr, resumeNote].filter(Boolean).join('\n\n');
                  setPreAnalyzeNote(combined);
                  await handleAnalyze(combined || undefined);
                  setSelectedTemplateId('');
                }}
              >
                Lancer
              </button>
            </div>
          </div>
        </div>
      )}

      {showQuoteConfirm && (() => {
        const prenom = (recipient?.name || '').split(/\s+/)[0] || 'Madame, Monsieur';
        const mailGeneral =
          `Bonjour ${prenom},\n\n` +
          `Veuillez trouver ci-joint votre devis.\n\n` +
          `Pour donner suite à ce devis, il vous suffit de nous retourner le devis signé ou votre accord par retour de mail, puis de procéder au virement bancaire aux coordonnées indiquées sur le devis.\n\n` +
          `N'hésitez pas à nous contacter si vous avez la moindre question.`;
        const mailChorus =
          `Bonjour ${prenom},\n\n` +
          `Veuillez trouver ci-joint votre devis.\n\n` +
          `Pour donner suite, nous vous remercions de bien vouloir nous transmettre votre validation écrite (bon de commande, accord signé) par retour de mail. Nous procéderons ensuite à la livraison, puis le règlement pourra se faire par Chorus Pro à réception, conformément à la procédure des marchés publics.\n\n` +
          `N'hésitez pas à nous contacter si vous avez la moindre question.`;
        const buildClaudeNote = (consigne: string): string => {
          const parts: string[] = [];
          parts.push(`Le brouillon que tu vas rédiger accompagne un DEVIS PDF qui vient d'être généré (référence : ${quoteNumber || 'en cours'}) et qui sera joint automatiquement au mail. Tu n'as PAS à reprendre les détails chiffrés du devis (produits, prix, totaux) — le client les verra dans le PDF.`);
          if (consigne.trim()) {
            parts.push(`Consigne du gérant : ${consigne.trim()}`);
          } else {
            parts.push(`Aucune consigne particulière du gérant — adapte-toi au fil de la conversation : si le client a posé une question ou exprimé une attente, prends-la en compte avant ou après la mention du devis joint.`);
          }
          parts.push(`Rédige un mail bref (4-8 lignes max), poli, en français. Termine par une invitation à revenir vers nous en cas de question.`);
          return parts.join('\n\n');
        };
        return (
          <div style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
          }}>
            <div style={{
              background: 'white', borderRadius: '12px', padding: '20px', maxWidth: '360px', width: '90%',
              boxShadow: '0 4px 20px rgba(0,0,0,0.15)', color: '#000',
            }}>
              {quoteMailMode === 'choose' && (
                <>
                  <p style={{ fontSize: '14px', fontWeight: 600, marginBottom: '14px', lineHeight: '1.5', color: '#000' }}>
                    Quel mail joindre au devis ?
                  </p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <button
                      className="btn-primary"
                      style={{ textAlign: 'left', padding: '10px 12px' }}
                      onClick={() => {
                        setQuoteDraftText(mailGeneral);
                        setShowQuoteConfirm(false);
                      }}
                    >
                      📄 &nbsp;Mail général
                      <div style={{ fontSize: '11px', fontWeight: 400, opacity: 0.8, marginTop: '2px' }}>
                        Standard, règlement par virement
                      </div>
                    </button>
                    <button
                      className="btn-primary"
                      style={{ textAlign: 'left', padding: '10px 12px' }}
                      onClick={() => {
                        setQuoteDraftText(mailChorus);
                        setShowQuoteConfirm(false);
                      }}
                    >
                      🏛️ &nbsp;Mail Chorus Pro
                      <div style={{ fontSize: '11px', fontWeight: 400, opacity: 0.8, marginTop: '2px' }}>
                        Mairies / établissements publics
                      </div>
                    </button>
                    <button
                      className="btn-primary"
                      style={{ textAlign: 'left', padding: '10px 12px' }}
                      onClick={() => setQuoteMailMode('consigne')}
                    >
                      🤖 &nbsp;Autre mail (Claude)
                      <div style={{ fontSize: '11px', fontWeight: 400, opacity: 0.8, marginTop: '2px' }}>
                        Mail custom contextuel — donne une consigne courte
                      </div>
                    </button>
                    <button
                      className="btn-outline"
                      style={{ marginTop: '4px' }}
                      onClick={() => setShowQuoteConfirm(false)}
                    >
                      Annuler
                    </button>
                  </div>
                </>
              )}
              {quoteMailMode === 'consigne' && (
                <>
                  <p style={{ fontSize: '14px', fontWeight: 600, marginBottom: '6px', lineHeight: '1.5', color: '#000' }}>
                    🤖 &nbsp;Mail custom (Claude)
                  </p>
                  <p style={{ fontSize: '12px', color: '#000', marginBottom: '10px', lineHeight: '1.45' }}>
                    Donne une consigne courte à Claude. Il rédigera un mail adapté à la conv qui accompagnera le devis PDF. Laisse vide → Claude s'adapte tout seul à la conversation.
                  </p>
                  <textarea
                    value={quoteClaudeConsigne}
                    onChange={(e) => setQuoteClaudeConsigne(e.target.value)}
                    placeholder="Ex: Réponds à sa question sur les délais avant de transmettre le devis."
                    rows={3}
                    style={{
                      width: '100%', padding: '8px 10px', fontSize: '13px',
                      border: '1px solid #ddd', borderRadius: '6px', resize: 'vertical',
                      fontFamily: 'inherit', marginBottom: '12px', color: '#000', background: 'white',
                    }}
                  />
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button
                      className="btn-outline"
                      style={{ flex: 1 }}
                      onClick={() => setQuoteMailMode('choose')}
                    >
                      Retour
                    </button>
                    <button
                      className="btn-primary"
                      style={{ flex: 1 }}
                      onClick={async () => {
                        const note = buildClaudeNote(quoteClaudeConsigne);
                        setShowQuoteConfirm(false);
                        // Bypass du mail-type → Claude rédige, son output sera utilisé au push
                        setQuoteDraftText(null);
                        setManualValidation(false);
                        setDraftInvalidated(true);
                        setPreAnalyzeNote(note);
                        await handleAnalyze(note);
                      }}
                    >
                      Lancer
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        );
      })()}

      </div>
      {/* ═══ CONTAINER BOUTONS FIXE EN BAS ═══ */}
      {/* Visible aussi si on a un quoteDraftText (cas brouillon injecté par
          PaymentCheckPanel sans passer par "Analyser avec Claude").
          MASQUÉE quand le masque devis PDF est actif (QuotePanel en état
          verify / extracting / creating) : le form doit avoir toute la
          hauteur pour être lisible, et seuls Annuler / Créer devis PDF
          dans Pennylane doivent apparaître (règle Charles 03/07/2026). */}
      {(hasMessages || quoteDraftText) && !claude.isStreaming && !quotePanelActive && (
        <div className="actions-container">
          {/* Brouillon validé */}
          {showDraft && (
            <>
              <button className="btn-outline" onClick={() => { setManualValidation(false); setDraftInvalidated(true); setQuoteDraftText(null); }}>
                Modifier le brouillon
              </button>
              <div style={{ display: 'flex', gap: '6px', alignItems: 'stretch' }}>
                <select
                  value={pushLang}
                  onChange={(e) => setPushLang(e.target.value)}
                  style={{ padding: '4px 6px', fontSize: '12px', border: '1px solid #ddd', borderRadius: '6px', background: 'white' }}
                >
                  <option value="auto">Détection...</option>
                  <option value="fr">Français</option>
                  <option value="en">Anglais</option>
                  <option value="de">Allemand</option>
                  <option value="nl">Néerlandais</option>
                  <option value="es">Espagnol</option>
                  <option value="it">Italien</option>
                  <option value="pt">Portugais</option>
                </select>
                <button
                  className={quotePdfUrl ? 'btn-push-pdf' : 'btn-push'}
                  style={{ flex: 1 }}
                  onClick={() => {
                    const content = quoteDraftText || lastAssistantMsg?.content || '';
                    const cleaned = quoteDraftText ? content : cleanDraft(content);
                    // Si la langue détectée chez le client diffère de la
                    // langue actuelle du push (= langue boutique par défaut),
                    // on demande au gérant ce qu'il préfère.
                    let chosenLang = pushLang;
                    if (detectedLang && pushLang !== 'auto' && detectedLang !== pushLang) {
                      const names: Record<string, string> = {
                        fr: 'français', en: 'anglais', de: 'allemand', nl: 'néerlandais',
                        es: 'espagnol', it: 'italien', pt: 'portugais',
                      };
                      const clientLabel = names[detectedLang] || detectedLang;
                      const shopLabel = names[pushLang] || pushLang;
                      const ok = window.confirm(
                        `⚠️ Langue du client détectée : ${clientLabel}\n` +
                        `Langue de la boutique : ${shopLabel}\n\n` +
                        `OK → traduire dans la langue du CLIENT (${clientLabel})\n` +
                        `Annuler → garder la langue de la BOUTIQUE (${shopLabel})`
                      );
                      chosenLang = ok ? detectedLang : pushLang;
                    }
                    pushDraft.handlePush(cleaned, quotePdfUrl || undefined, quoteNumber || undefined, mailThread, store?.code, chosenLang === 'auto' ? undefined : chosenLang, templateAttachmentUrl || undefined);
                  }}
                  disabled={pushDraft.pushing}
                >
                  {pushDraft.pushing ? 'Envoi...' : quotePdfUrl ? 'Pousser avec PDF' : 'Pousser dans Front App'}
                </button>
              </div>
            </>
          )}

          {/* Répondre aux questions Claude — visible tant qu'il y a des
              questions actionnables (🔴/🟠, hors 🟢 INFO). Reste dispo pour
              des allers-retours multiples (règle Charles 03/07/2026).
              Masqué en mode brouillon validé (showDraft) — cf. règle
              navigation Charles 03/07/2026 : quand on a validé, on ne
              revient plus dialoguer avec l'agent (il faut cliquer
              "Modifier le brouillon" pour retomber en mode dialogue). */}
          {actionableQuestions.length > 0 && !claude.isStreaming && !showDraft && (
            <button
              className="btn-outline"
              style={{ fontWeight: 600 }}
              onClick={() => {
                // Réinitialise les inputs avec "à toi de décider" par défaut
                const init: Record<number, string> = {};
                actionableQuestions.forEach((q) => { init[q.num] = ANSWER_DEFAULT; });
                setAnswerInputs(init);
                setAnswerOther('');
                setShowAnswerModal(true);
              }}
            >
              💬 Répondre à l'agent ({actionableQuestions.length})
            </button>
          )}

          {/* Brouillon pas validé */}
          {!showDraft && hasDraft && (
            <button className="btn-validate" onClick={() => { setManualValidation(true); setDraftInvalidated(false); }}>
              Valider le brouillon
            </button>
          )}

          {/* Devis PDF : permet de (re)générer TANT QUE le brouillon n'est
              pas validé. En mode brouillon validé, on masque : le gérant
              doit soit "Modifier le brouillon" pour revenir, soit pousser
              tel quel dans Front. */}
          {showQuotePanel && lastAssistantMsg && !showDraft && (
            <button className="btn-quote" onClick={() => quoteClickRef.current?.()}>
              📄
              Générer devis PDF
            </button>
          )}

          {/* Vérifier virement reçu — masqué en mode brouillon validé pour
              la même raison (règle Charles 03/07/2026 : après validation,
              seuls Modifier + Pousser + Reprendre restent). Couleur :
              violet (btn-payment), même que sur la page d'accueil. */}
          {!showDraft && (
            <button
              className="btn-payment"
              onClick={() => setShowPaymentCheck(true)}
            >
              💳 Vérifier virement reçu
            </button>
          )}

          {/* Boutons secondaires : Reprendre avec Claude + Reprendre à 0 */}
          <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
            <button
              className="btn-outline"
              style={{ fontSize: '12px', opacity: 0.8, flex: 1 }}
              onClick={() => { setResumeNote(''); setShowResumePopup(true); }}
            >
              Reprendre avec Claude
            </button>
            <button
              className="btn-outline"
              style={{ fontSize: '12px', opacity: 0.7, flex: 1 }}
              onClick={async () => {
                if (!store) return;
                await conversationCache.deleteFromDB(frontConvId, store.code);
                claude.reset(frontConvId);
                setManualValidation(false);
                setDraftInvalidated(false);
                setQuotePdfUrl(null);
                setQuoteNumber(null);
                setQuotePennylaneUrl(null);
                setQuoteDraftText(null);
                setMailThread('');
                setShowQuoteConfirm(false);
              }}
            >
              Reprendre à 0
            </button>
          </div>
        </div>
      )}

      {/* Panel "Vérifier virement reçu" — accepte quoteNumber=null si la conv
          n'a pas de devis en BDD (le panel propose la saisie manuelle). */}
      {showPaymentCheck && (
        <PaymentCheckPanel
          frontConversationId={frontConvId}
          storeCode={store.code}
          customerName={resolvedName || recipient?.name || ''}
          quoteNumber={quoteNumber || ''}
          onClose={() => setShowPaymentCheck(false)}
          onPreviewReady={(text) => {
            // Injecte le brouillon préparé dans le bloc DraftFinal habituel
            // pour validation/édition/push par le flow classique.
            setQuoteDraftText(text);
            setManualValidation(true);
            setDraftInvalidated(false);
            // Le PDF du devis n'est PAS attaché à ce brouillon de confirmation
            setQuotePdfUrl(null);
          }}
        />
      )}

      {/* Modal "Répondre à l'agent" — un textarea par question actionnable
          (🔴/🟠, hors 🟢 INFO) + une zone libre "Autre remarque". Chaque
          case pré-remplie avec « à toi de décider » en gris clair pour
          signifier au gérant qu'il peut soit laisser ainsi (Claude
          décidera) soit remplacer par sa réponse. Envoie le tout à Claude
          via /message. */}
      {showAnswerModal && (
        <div
          style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2100 }}
          onClick={() => setShowAnswerModal(false)}
        >
          <div
            style={{ background: 'white', borderRadius: '12px', padding: '18px', maxWidth: '520px', width: '92%', maxHeight: '85vh', overflowY: 'auto', boxShadow: '0 4px 20px rgba(0,0,0,0.15)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ fontWeight: 700, fontSize: '15px', marginBottom: '12px', color: '#1a202c' }}>
              💬 Répondre à l'agent
            </div>
            <div style={{ fontSize: '11.5px', color: '#4a5568', marginBottom: '14px', lineHeight: 1.4 }}>
              Réponds question par question. Laisse « à toi de décider » si tu veux que Claude tranche lui-même.
            </div>
            {actionableQuestions.map((q) => {
              const val = answerInputs[q.num] ?? ANSWER_DEFAULT;
              const isDefault = val === ANSWER_DEFAULT;
              return (
                <div key={q.num} style={{ marginBottom: '12px' }}>
                  <div style={{ fontSize: '12px', fontWeight: 600, color: '#1a202c', marginBottom: '4px', lineHeight: 1.4 }}>
                    {q.num}. {q.text}
                  </div>
                  <textarea
                    value={val}
                    onFocus={(e) => {
                      if (e.target.value === ANSWER_DEFAULT) e.target.select();
                    }}
                    onChange={(e) => setAnswerInputs((prev) => ({ ...prev, [q.num]: e.target.value }))}
                    style={{
                      width: '100%',
                      minHeight: '48px',
                      maxHeight: '160px',
                      padding: '6px 8px',
                      fontSize: '12px',
                      border: '1px solid #cbd5e0',
                      borderRadius: '4px',
                      color: isDefault ? '#a0aec0' : '#1a202c',
                      fontStyle: isDefault ? 'italic' as const : 'normal' as const,
                      background: '#fff',
                      resize: 'vertical' as const,
                      fontFamily: 'inherit',
                    }}
                  />
                </div>
              );
            })}
            <div style={{ marginBottom: '16px' }}>
              <div style={{ fontSize: '12px', fontWeight: 600, color: '#1a202c', marginBottom: '4px' }}>
                Autre remarque (optionnel)
              </div>
              <textarea
                value={answerOther}
                onChange={(e) => setAnswerOther(e.target.value)}
                placeholder="Précision libre à ajouter au message envoyé à Claude..."
                style={{
                  width: '100%',
                  minHeight: '48px',
                  maxHeight: '160px',
                  padding: '6px 8px',
                  fontSize: '12px',
                  border: '1px solid #cbd5e0',
                  borderRadius: '4px',
                  color: '#1a202c',
                  background: '#fff',
                  resize: 'vertical' as const,
                  fontFamily: 'inherit',
                }}
              />
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                className="btn-secondary"
                style={{ flex: 1 }}
                onClick={() => setShowAnswerModal(false)}
              >
                Annuler
              </button>
              <button
                className="btn-primary"
                style={{ flex: 2 }}
                onClick={() => {
                  // Construire le message à envoyer à Claude. Chaque question
                  // reprend son numéro et sa réponse (ou "à toi de décider"
                  // si laissée par défaut). Autre remarque optionnelle.
                  const lines: string[] = ['Voici mes réponses à tes questions :', ''];
                  actionableQuestions.forEach((q) => {
                    const raw = (answerInputs[q.num] ?? ANSWER_DEFAULT).trim();
                    const val = raw.length > 0 ? raw : ANSWER_DEFAULT;
                    lines.push(`${q.num}. ${val}`);
                  });
                  const other = answerOther.trim();
                  if (other) {
                    lines.push('');
                    lines.push(`Autre : ${other}`);
                  }
                  const message = lines.join('\n');
                  claude.sendMessage(message);
                  setShowAnswerModal(false);
                }}
              >
                Envoyer à Claude
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Popup résumé template — z-index élevé, au-dessus de tout */}
      {showTemplateSummary && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000 }}
          onClick={() => setShowTemplateSummary(null)}>
          <div style={{ background: 'white', borderRadius: '12px', padding: '16px', maxWidth: '300px', width: '90%', boxShadow: '0 4px 20px rgba(0,0,0,0.15)', whiteSpace: 'pre-wrap' }}
            onClick={(e) => e.stopPropagation()}>
            <p style={{ fontSize: '13px', lineHeight: '1.5' }}>{showTemplateSummary}</p>
            <button className="btn-outline" style={{ marginTop: '10px', width: '100%' }} onClick={() => setShowTemplateSummary(null)}>Fermer</button>
          </div>
        </div>
      )}
    </div>
  );
}
