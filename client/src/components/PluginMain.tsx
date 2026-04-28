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
import ErrorBoundary from './ErrorBoundary';
import LoadingState from './LoadingState';
import { isDraftReady } from '../utils/cleanDraft';

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
  const [manualValidation, setManualValidation] = useState(false);
  const [draftInvalidated, setDraftInvalidated] = useState(false);
  const [quotePdfUrl, setQuotePdfUrl] = useState<string | null>(null);
  const [quoteNumber, setQuoteNumber] = useState<string | null>(null);
  const [quotePennylaneUrl, setQuotePennylaneUrl] = useState<string | null>(null);
  const [quoteDraftText, setQuoteDraftText] = useState<string | null>(null);
  const [mailThread, setMailThread] = useState<string>('');
  const [showQuoteConfirm, setShowQuoteConfirm] = useState(false);
  const [preAnalyzeNote, setPreAnalyzeNote] = useState<string>('');
  const [showResumePopup, setShowResumePopup] = useState(false);
  const [resumeNote, setResumeNote] = useState<string>('');
  const [resolvedEmail, setResolvedEmail] = useState<string>('');
  const [resolvedName, setResolvedName] = useState<string>('');
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

  async function handleAnalyze(noteOverride?: string) {
    console.log('[plugin] handleAnalyze called');
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

  // État initial : pas encore d'analyse
  const hasMessages = claude.messages.length > 0;

  // Détecter si le brouillon est prêt
  // RÈGLE STRICTE : le bloc vert n'apparaît JAMAIS si Claude a des questions en attente
  // sauf si l'utilisateur clique manuellement "Valider le brouillon"
  const lastAssistantMsg = [...claude.messages].reverse().find((m) => m.role === 'assistant');
  const hasDraft = lastAssistantMsg?.content.includes('Bonjour') ?? false;
  const autoReady = lastAssistantMsg ? isDraftReady(lastAssistantMsg.content) : false;
  const showDraft = !claude.isStreaming && hasDraft && (autoReady || manualValidation) && !draftInvalidated;

  // QuotePanel visible dès qu'il y a au moins un message Claude
  const showQuotePanel = hasMessages && !claude.isStreaming;

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

      {claude.error && (
        <div className="plugin-error">
          <p>{claude.error}</p>
          <button onClick={claude.clearError}>Fermer</button>
        </div>
      )}

      {loadingHistory && (
        <LoadingState message="Chargement de l'historique..." />
      )}

      {!hasMessages && !claude.isStreaming && !loadingHistory && conversationCache.isPending(frontConvId) && (
        <LoadingState message="Analyse en cours sur ce mail..." />
      )}

      {!hasMessages && !claude.isStreaming && !loadingHistory && !conversationCache.isPending(frontConvId) && (
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
          <button className="btn-primary" onClick={() => handleAnalyze()}>
            Analyser avec Claude
          </button>
        </div>
      )}

      {!hasMessages && claude.isStreaming && !claude.streamingContent && (
        <LoadingState progressive />
      )}

      {(hasMessages || claude.streamingContent) && (
        <ClaudeChat
          messages={claude.messages}
          streamingContent={claude.streamingContent}
          isStreaming={claude.isStreaming}
          onSend={claude.sendMessage}
        />
      )}

      {/* Texte brouillon validé (fond vert) — dans la zone scrollable */}
      {showDraft && lastAssistantMsg && (
        <DraftFinal
          rawContent={quoteDraftText || lastAssistantMsg.content}
          context={context}
          pdfUrl={quotePdfUrl || undefined}
          quoteNumber={quoteNumber || undefined}
          skipClean={!!quoteDraftText}
          pushError={pushDraft.pushError}
          pushSuccess={pushDraft.pushSuccess}
        />
      )}

      {/* QuotePanel caché (gère les states missing/form/creating/done + enregistre handleClick) */}
      {showQuotePanel && lastAssistantMsg && !(quoteNumber && quotePennylaneUrl) && (
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
            onQuoteCreated={(pdfUrl, qNumber, pennylaneUrl) => {
              setQuotePdfUrl(pdfUrl);
              setQuoteNumber(qNumber);
              setQuotePennylaneUrl(pennylaneUrl);
              setManualValidation(true);
              setDraftInvalidated(false);
              // Sauvegarder dans le cache pour persistance
              conversationCache.setQuoteInCache(frontConvId, { pdfUrl, quoteNumber: qNumber, pennylaneUrl });
              // Persister en BDD pour retrouver le devis plus tard
              fetch(`${window.location.origin}/api/plugin/quote-history`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ frontConversationId: frontConvId, storeCode: store?.code, quoteNumber: qNumber, pennylaneUrl, pdfUrl }),
              }).catch(() => {});
              // Demander si on remplace le brouillon par le mail générique devis
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
                  setPreAnalyzeNote(resumeNote);
                  await handleAnalyze(resumeNote);
                }}
              >
                Lancer
              </button>
            </div>
          </div>
        </div>
      )}

      {showQuoteConfirm && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
        }}>
          <div style={{
            background: 'white', borderRadius: '12px', padding: '20px', maxWidth: '320px', width: '90%',
            boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
          }}>
            <p style={{ fontSize: '14px', marginBottom: '16px', lineHeight: '1.5' }}>
              Remplacer le brouillon par le mail d'accompagnement du devis ?
            </p>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                className="btn-outline"
                style={{ flex: 1 }}
                onClick={() => setShowQuoteConfirm(false)}
              >
                Non
              </button>
              <button
                className="btn-primary"
                style={{ flex: 1 }}
                onClick={() => {
                  const prenom = (recipient?.name || '').split(/\s+/)[0] || 'Madame, Monsieur';
                  setQuoteDraftText(
                    `Bonjour ${prenom},\n\n` +
                    `Veuillez trouver ci-joint votre devis.\n\n` +
                    `Pour donner suite à ce devis, il vous suffit de nous retourner le devis signé ou votre accord par retour de mail, puis de procéder au virement bancaire aux coordonnées indiquées sur le devis.\n\n` +
                    `N'hésitez pas à nous contacter si vous avez la moindre question.`
                  );
                  setShowQuoteConfirm(false);
                }}
              >
                Oui
              </button>
            </div>
          </div>
        </div>
      )}

      </div>
      {/* ═══ CONTAINER BOUTONS FIXE EN BAS ═══ */}
      {hasMessages && !claude.isStreaming && (
        <div className="actions-container">
          {/* Brouillon validé */}
          {showDraft && (
            <>
              <button className="btn-outline" onClick={() => { setManualValidation(false); setDraftInvalidated(true); setQuoteDraftText(null); }}>
                Modifier le brouillon
              </button>
              <button
                className={quotePdfUrl ? 'btn-push-pdf' : 'btn-push'}
                onClick={() => {
                  const content = quoteDraftText || lastAssistantMsg?.content || '';
                  const cleaned = quoteDraftText ? content : cleanDraft(content);
                  pushDraft.handlePush(cleaned, quotePdfUrl || undefined, quoteNumber || undefined, mailThread, store?.code);
                }}
                disabled={pushDraft.pushing}
              >
                {pushDraft.pushing ? 'Envoi...' : quotePdfUrl ? 'Pousser avec PDF' : 'Pousser dans Front App'}
              </button>
            </>
          )}

          {/* Brouillon pas validé */}
          {!showDraft && hasDraft && (
            <button className="btn-validate" onClick={() => { setManualValidation(true); setDraftInvalidated(false); }}>
              Valider le brouillon
            </button>
          )}

          {/* Devis PDF : modifier (si déjà créé) */}
          {showQuotePanel && lastAssistantMsg && quoteNumber && quotePennylaneUrl && (
            <a
              href={quotePennylaneUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-quote"
              style={{ display: 'block', textAlign: 'center', textDecoration: 'none' }}
            >
              📄
              Modifier le devis PDF
            </a>
          )}

          {/* Devis PDF : générer (si pas encore créé) */}
          {showQuotePanel && lastAssistantMsg && !(quoteNumber && quotePennylaneUrl) && (
            <button className="btn-quote" onClick={() => quoteClickRef.current?.()}>
              📄
              Générer devis PDF
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
    </div>
  );
}
