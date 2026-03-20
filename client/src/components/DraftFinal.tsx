import { useState, useEffect, useRef } from 'react';
import type { FrontSingleConversationContext } from '../providers/FrontContext';
import { cleanDraft } from '../utils/cleanDraft';
import { textToHtml } from '../utils/textToHtml';

interface DraftFinalProps {
  rawContent: string;
  context: FrontSingleConversationContext;
}

export default function DraftFinal({ rawContent, context }: DraftFinalProps) {
  const [pushing, setPushing] = useState(false);
  const [pushCount, setPushCount] = useState(0);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const prevContent = useRef(rawContent);

  const cleaned = cleanDraft(rawContent);

  // Réinitialiser quand le contenu du brouillon change (nouveau brouillon après échange)
  useEffect(() => {
    if (rawContent !== prevContent.current) {
      prevContent.current = rawContent;
      setPushCount(0);
      setError(null);
    }
  }, [rawContent]);

  async function handleCopy() {
    await navigator.clipboard.writeText(cleaned);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handlePush() {
    setPushing(true);
    setError(null);

    try {
      const messagesResponse = await context.listMessages();
      const messages = messagesResponse.results;

      if (messages.length === 0) {
        throw new Error('Aucun message dans la conversation');
      }

      const latestMessageId = messages[messages.length - 1].id;

      console.log('[plugin] createDraft, pushCount:', pushCount);

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

      setPushCount((c) => c + 1);
    } catch (err) {
      console.error('[plugin] createDraft error:', err);
      setError(err instanceof Error ? err.message : 'Erreur lors du push');
    } finally {
      setPushing(false);
    }
  }

  return (
    <div className="draft-final">
      <div className="draft-final-header">Mail final</div>
      <div className="draft-final-content">{cleaned}</div>

      {error && (
        <p style={{ color: 'var(--error)', fontSize: '12px', marginBottom: '8px' }}>{error}</p>
      )}

      {pushCount > 0 && (
        <p style={{ color: 'var(--success)', fontSize: '12px', marginBottom: '8px' }}>
          Brouillon poussé dans Front App.
        </p>
      )}

      <div className="draft-final-actions">
        <button className="btn-secondary" onClick={handleCopy}>
          {copied ? 'Copié !' : 'Copier'}
        </button>
        <button className="btn-primary" onClick={handlePush} disabled={pushing} style={{ width: 'auto' }}>
          {pushing ? 'Envoi...' : pushCount > 0 ? 'Repousser dans Front App' : 'Pousser dans Front App'}
        </button>
      </div>
    </div>
  );
}
