import { useState, useEffect, useRef } from 'react';
import type { FrontSingleConversationContext } from '../providers/FrontContext';
import { detectStore } from '../hooks/useStore';
import { useClaude } from '../hooks/useClaude';
import { useConversationCache } from '../hooks/useConversationCache';
import MailPreview from './MailPreview';
import ClaudeChat from './ClaudeChat';
import DraftFinal from './DraftFinal';
import QuotePanel from './QuotePanel';
import ErrorBoundary from './ErrorBoundary';
import LoadingState from './LoadingState';
import { isDraftReady } from '../utils/cleanDraft';

/** Structure réelle d'un message Front SDK */
interface FrontMessage {
  id: string;
  date: number;
  content?: { body?: string; type?: string };
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
  const [manualValidation, setManualValidation] = useState(false);
  const [quotePdfUrl, setQuotePdfUrl] = useState<string | null>(null);
  const [quoteNumber, setQuoteNumber] = useState<string | null>(null);
  const [quotePennylaneUrl, setQuotePennylaneUrl] = useState<string | null>(null);
  const [quoteDraftText, setQuoteDraftText] = useState<string | null>(null);
  const [mailThread, setMailThread] = useState<string>('');
  const [loadingHistory, setLoadingHistory] = useState(false);
  const prevConvId = useRef<string>('');

  const recipient = context.conversation.recipient;
  const subject = context.conversation.subject;
  const frontConvId = context.conversation.id;

  // Quand la conversation Front change → charger l'historique depuis le cache ou la BDD
  useEffect(() => {
    if (!frontConvId || frontConvId === prevConvId.current) return;
    prevConvId.current = frontConvId;

    // Reset les states liés au devis
    setManualValidation(false);
    setQuotePdfUrl(null);
    setQuoteNumber(null);
    setQuotePennylaneUrl(null);
    setQuoteDraftText(null);

    // 1. Vérifier le cache mémoire
    const cached = conversationCache.getFromCache(frontConvId);
    if (cached) {
      console.log(`[plugin] cache hit for ${frontConvId}: ${cached.messages.length} msgs`);
      claude.restore(cached.messages, cached.conversationId);
      return;
    }

    // 2. Charger depuis la BDD
    if (!store) return;
    setLoadingHistory(true);
    conversationCache.loadFromDB(frontConvId, store.code).then((result) => {
      if (result && frontConvId === prevConvId.current) {
        console.log(`[plugin] DB hit for ${frontConvId}: ${result.messages.length} msgs`);
        claude.restore(result.messages, result.conversationId);
      } else if (frontConvId === prevConvId.current) {
        // Pas d'historique → reset
        claude.reset();
      }
      setLoadingHistory(false);
    });
  }, [frontConvId, store, claude, conversationCache]);

  // Sauvegarder dans le cache quand les messages changent
  useEffect(() => {
    if (claude.messages.length > 0 && claude.conversationId && frontConvId) {
      conversationCache.setInCache(frontConvId, {
        conversationId: claude.conversationId,
        messages: claude.messages,
      });
    }
  }, [claude.messages, claude.conversationId, frontConvId, conversationCache]);

  if (!store) {
    return (
      <div className="plugin-empty">
        <p>Boutique non reconnue pour cette inbox.</p>
      </div>
    );
  }

  async function handleAnalyze() {
    console.log('[plugin] handleAnalyze called');
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

      const payload = {
        storeCode: store!.code,
        customerEmail,
        customerName,
        mailContent,
        frontConversationId: context.conversation.id,
        subject,
      };
      console.log('[plugin] payload preview:', {
        storeCode: payload.storeCode,
        customerEmail: payload.customerEmail,
        customerName: payload.customerName,
        mailContentLength: payload.mailContent.length,
        mailContentPreview: payload.mailContent.substring(0, 200),
        frontConversationId: payload.frontConversationId,
      });

      // Stocker le fil de mails pour le QuotePanel
      setMailThread(mailContent);

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
  const showDraft = !claude.isStreaming && hasDraft && (autoReady || manualValidation);

  // QuotePanel visible dès qu'il y a au moins un message Claude
  const showQuotePanel = hasMessages && !claude.isStreaming;

  return (
    <div className="plugin-main">
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

      {!hasMessages && !claude.isStreaming && !loadingHistory && (
        <div className="plugin-actions">
          <button className="btn-primary" onClick={handleAnalyze}>
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

      {/* Bouton "Valider le brouillon" : visible quand il y a un brouillon avec des questions, pas encore validé */}
      {hasMessages && !claude.isStreaming && !showDraft && hasDraft && !manualValidation && (
        <div className="plugin-actions">
          <button className="btn-primary" onClick={() => setManualValidation(true)}>
            Valider le brouillon
          </button>
        </div>
      )}

      {/* QuotePanel : état "done" géré ici pour éviter la perte de state */}
      {showQuotePanel && lastAssistantMsg && quoteNumber && quotePennylaneUrl ? (
        <div className="quote-panel">
          <p style={{ fontSize: '13px' }}>
            Le devis {quoteNumber} a bien été généré depuis Pennylane et chargé dans le brouillon.
          </p>
          <a
            href={quotePennylaneUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-primary"
            style={{ display: 'block', textAlign: 'center', textDecoration: 'none', marginTop: '10px' }}
          >
            Modifier le devis PDF
          </a>
        </div>
      ) : showQuotePanel && lastAssistantMsg ? (
        <ErrorBoundary>
          <QuotePanel
            claudeText={claude.messages.filter(m => m.role === 'assistant').map(m => m.content).join('\n\n---\n\n')}
            mailThread={mailThread}
            customerEmail={recipient?.handle || ''}
            customerName={recipient?.name || ''}
            storeCode={store.code}
            inboxName={store.inboxName}
            onSendMessage={claude.sendMessage}
            onQuoteCreated={(pdfUrl, qNumber, pennylaneUrl) => {
              setQuotePdfUrl(pdfUrl);
              setQuoteNumber(qNumber);
              setQuotePennylaneUrl(pennylaneUrl);
              const prenom = (recipient?.name || '').split(/\s+/)[0] || 'Madame, Monsieur';
              setQuoteDraftText(
                `Bonjour ${prenom},\n\n` +
                `Veuillez trouver ci-joint votre devis pour votre filet de camouflage sur mesure.\n\n` +
                `Pour donner suite à ce devis, il vous suffit de nous retourner le devis signé ou votre accord par retour de mail, puis de procéder au virement bancaire aux coordonnées indiquées sur le devis.\n\n` +
                `La mise en production sera lancée dès réception du règlement, avec un délai de fabrication et de livraison d'environ 14 jours.\n\n` +
                `N'hésitez pas à nous contacter si vous avez la moindre question.`
              );
              setManualValidation(true);
            }}
          />
        </ErrorBoundary>
      ) : null}

      {showDraft && lastAssistantMsg && (
        <DraftFinal
          rawContent={quoteDraftText || lastAssistantMsg.content}
          context={context}
          pdfUrl={quotePdfUrl || undefined}
          quoteNumber={quoteNumber || undefined}
          skipClean={!!quoteDraftText}
        />
      )}
    </div>
  );
}
