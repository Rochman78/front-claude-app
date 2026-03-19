import type { FrontSingleConversationContext } from '../providers/FrontContext';
import { detectStore } from '../hooks/useStore';
import { useClaude } from '../hooks/useClaude';
import MailPreview from './MailPreview';
import ClaudeChat from './ClaudeChat';
import DraftFinal from './DraftFinal';
import LoadingState from './LoadingState';

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
    try {
      // Récupérer les messages du fil via le SDK Front
      const messagesResponse = await context.listMessages();
      const messages = messagesResponse.results;

      if (messages.length === 0) {
        return;
      }

      // Formater le fil de mails
      const mailContent = messages
        .map((msg) => {
          const author = msg.author?.name || msg.author?.email || 'Inconnu';
          const date = new Date(msg.date * 1000).toLocaleString('fr-FR');
          const text = msg.body.replace(/<[^>]+>/g, '').trim();
          return `[${date}] ${author} :\n${text}`;
        })
        .join('\n\n---\n\n');

      await claude.analyze({
        storeCode: store!.code,
        customerEmail: recipient?.handle || '',
        customerName: recipient?.name || '',
        mailContent,
        frontConversationId: context.conversation.id,
        subject,
      });
    } catch {
      // L'erreur est gérée dans useClaude
    }
  }

  // État initial : pas encore d'analyse
  const hasMessages = claude.messages.length > 0;

  // Détecter si le dernier message assistant contient un brouillon final
  const lastAssistantMsg = [...claude.messages].reverse().find((m) => m.role === 'assistant');
  const draftContent = lastAssistantMsg?.content.includes('Bonjour') ? lastAssistantMsg.content : null;

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
    </div>
  );
}
