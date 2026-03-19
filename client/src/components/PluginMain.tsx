import type { FrontSingleConversationContext } from '../providers/FrontContext';
import { detectStore } from '../hooks/useStore';
import { useClaude } from '../hooks/useClaude';
import MailPreview from './MailPreview';
import ClaudeChat from './ClaudeChat';
import DraftFinal from './DraftFinal';
import QuoteBlock from './QuoteBlock';
import LoadingState from './LoadingState';
import { detectQuoteJson } from '../utils/detectQuoteJson';

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
      // Log la structure du premier message pour debug
      if (messages[0]) {
        console.log('[plugin] first message keys:', Object.keys(messages[0]));
        console.log('[plugin] first message sample:', JSON.stringify(messages[0]).substring(0, 500));
      }

      // Formater le fil de mails
      const mailContent = messages
        .map((msg) => {
          const author = msg.author?.name || msg.author?.email || 'Inconnu';
          const date = new Date(msg.date * 1000).toLocaleString('fr-FR');
          // Le SDK Front peut exposer body, text, ou content selon la version
          const rawBody = msg.body || (msg as Record<string, unknown>).text || (msg as Record<string, unknown>).content || '';
          const text = String(rawBody).replace(/<[^>]+>/g, '').trim();
          return `[${date}] ${author} :\n${text}`;
        })
        .filter((entry) => entry.includes('\n') && entry.split('\n')[1]?.trim())
        .join('\n\n---\n\n');

      console.log('[plugin] calling claude.analyze...');

      await claude.analyze({
        storeCode: store!.code,
        customerEmail: recipient?.handle || '',
        customerName: recipient?.name || '',
        mailContent,
        frontConversationId: context.conversation.id,
        subject,
      });
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
