import { useState } from 'react';
import type { FrontSingleConversationContext } from '../providers/FrontContext';
import { detectStore } from '../hooks/useStore';
import MailPreview from './MailPreview';
import LoadingState from './LoadingState';

interface PluginMainProps {
  context: FrontSingleConversationContext;
}

export default function PluginMain({ context }: PluginMainProps) {
  const store = detectStore(context);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    setAnalyzing(true);
    setError(null);

    try {
      // Récupérer les messages du fil via le SDK Front
      const messagesResponse = await context.listMessages();
      const messages = messagesResponse.results;

      if (messages.length === 0) {
        setError('Aucun message dans cette conversation.');
        setAnalyzing(false);
        return;
      }

      // Formater le fil de mails
      const mailContent = messages
        .map((msg) => {
          const author = msg.author?.name || msg.author?.email || 'Inconnu';
          const date = new Date(msg.date * 1000).toLocaleString('fr-FR');
          // Nettoyer le HTML du body
          const text = msg.body.replace(/<[^>]+>/g, '').trim();
          return `[${date}] ${author} :\n${text}`;
        })
        .join('\n\n---\n\n');

      // TODO: Appeler /api/plugin/analyze (étape 4 — hook useClaude)
      console.log('[plugin] analyze:', { storeCode: store!.code, mailContent: mailContent.substring(0, 100) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Erreur inconnue';
      setError(msg);
    } finally {
      setAnalyzing(false);
    }
  }

  if (analyzing) {
    return <LoadingState message="Analyse en cours avec Claude..." />;
  }

  return (
    <div className="plugin-main">
      <MailPreview
        storeCode={store.code}
        customerName={recipient?.name || ''}
        customerEmail={recipient?.handle || ''}
        subject={subject}
      />

      {error && (
        <div className="plugin-error">
          <p>{error}</p>
          <button onClick={() => setError(null)}>Fermer</button>
        </div>
      )}

      <div className="plugin-actions">
        <button className="btn-primary" onClick={handleAnalyze}>
          Analyser avec Claude
        </button>
      </div>
    </div>
  );
}
