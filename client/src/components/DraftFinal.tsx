import { useState } from 'react';
import type { FrontSingleConversationContext } from '../providers/FrontContext';
import { cleanDraft } from '../utils/cleanDraft';
import { textToHtml } from '../utils/textToHtml';

interface DraftFinalProps {
  rawContent: string;
  context: FrontSingleConversationContext;
}

export default function DraftFinal({ rawContent, context }: DraftFinalProps) {
  const [pushing, setPushing] = useState(false);
  const [pushed, setPushed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cleaned = cleanDraft(rawContent);

  async function handleCopy() {
    await navigator.clipboard.writeText(cleaned);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handlePush() {
    setPushing(true);
    setError(null);

    try {
      // Récupérer le dernier message pour le replyOptions
      const messagesResponse = await context.listMessages();
      const messages = messagesResponse.results;

      if (messages.length === 0) {
        throw new Error('Aucun message dans la conversation');
      }

      const latestMessageId = messages[messages.length - 1].id;

      await context.createDraft({
        content: {
          body: textToHtml(cleaned),
          type: 'html',
        },
        replyOptions: {
          type: 'reply',
          originalMessageId: latestMessageId,
        },
      });

      setPushed(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur lors du push');
    } finally {
      setPushing(false);
    }
  }

  if (pushed) {
    return (
      <div className="draft-final">
        <div className="draft-final-header">Brouillon poussé dans Front App</div>
        <p style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
          Le brouillon est visible dans le fil de conversation. Vous pouvez le modifier et l'envoyer.
        </p>
      </div>
    );
  }

  return (
    <div className="draft-final">
      <div className="draft-final-header">Mail final</div>
      <div className="draft-final-content">{cleaned}</div>

      {error && (
        <p style={{ color: 'var(--error)', fontSize: '12px', marginBottom: '8px' }}>{error}</p>
      )}

      <div className="draft-final-actions">
        <button className="btn-secondary" onClick={handleCopy}>
          {copied ? 'Copié !' : 'Copier'}
        </button>
        <button className="btn-primary" onClick={handlePush} disabled={pushing} style={{ width: 'auto' }}>
          {pushing ? 'Envoi...' : 'Pousser dans Front App'}
        </button>
      </div>
    </div>
  );
}
