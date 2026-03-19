import type { FrontSingleConversationContext } from '../providers/FrontContext';
import { detectStore } from '../hooks/useStore';
import { useClaude } from '../hooks/useClaude';
import MailPreview from './MailPreview';
import ClaudeChat from './ClaudeChat';
import DraftFinal from './DraftFinal';
import QuoteBlock from './QuoteBlock';
import LoadingState from './LoadingState';
import { detectQuoteJson } from '../utils/detectQuoteJson';

/** Structure réelle d'un message Front SDK */
interface FrontMessage {
  id: string;
  date: number;
  content?: { body?: string; type?: string };
  author?: { name?: string; email?: string };
  replyTo?: { handle?: string; contact?: { name?: string } };
}

/** Extrait le texte brut d'un message Front SDK. */
function extractText(msg: FrontMessage): string {
  // Le contenu est dans msg.content.body (HTML)
  const html = msg.content?.body || '';
  if (!html) return '';
  return html.replace(/<[^>]+>/g, '').trim();
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

  const recipient = context.conversation.recipient;
  const subject = context.conversation.subject;

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

      await claude.analyze(payload);
    } catch (err) {
      console.error('[plugin] handleAnalyze error:', err);
      // Remonter l'erreur à l'UI au lieu de l'avaler
      claude.setError(err instanceof Error ? err.message : 'Erreur lors de la récupération des messages');
    }
  }

  // État initial : pas encore d'analyse
  const hasMessages = claude.messages.length > 0;

  // Détecter si le dernier message assistant contient un brouillon final et/ou un devis
  const lastAssistantMsg = [...claude.messages].reverse().find((m) => m.role === 'assistant');
  const draftContent = lastAssistantMsg?.content.includes('Bonjour') ? lastAssistantMsg.content : null;
  const quoteData = lastAssistantMsg ? detectQuoteJson(lastAssistantMsg.content) : null;

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

      {!hasMessages && !claude.isStreaming && (
        <div className="plugin-actions">
          <button className="btn-primary" onClick={handleAnalyze}>
            Analyser avec Claude
          </button>
        </div>
      )}

      {!hasMessages && claude.isStreaming && !claude.streamingContent && (
        <LoadingState message="Analyse en cours avec Claude..." />
      )}

      {(hasMessages || claude.streamingContent) && (
        <ClaudeChat
          messages={claude.messages}
          streamingContent={claude.streamingContent}
          isStreaming={claude.isStreaming}
          onSend={claude.sendMessage}
        />
      )}

      {draftContent && !claude.isStreaming && (
        <DraftFinal rawContent={draftContent} context={context} />
      )}

      {quoteData && !claude.isStreaming && (
        <QuoteBlock quoteData={quoteData} inboxName={store.inboxName} />
      )}
    </div>
  );
}
