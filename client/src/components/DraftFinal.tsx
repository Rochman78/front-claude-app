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
  const [pushedContent, setPushedContent] = useState('');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Si déjà poussé → afficher le contenu figé, pas le nouveau
  const cleaned = pushed ? pushedContent : cleanDraft(rawContent);

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

      // Supprimer les brouillons existants via le backend (API REST Front)
      // pour éviter les doublons — le SDK ne permet pas de les supprimer
      try {
        const deleteRes = await fetch(`${window.location.origin}/api/plugin/delete-drafts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversationId: context.conversation.id }),
        });
        if (deleteRes.ok) {
          const result = await deleteRes.json();
          if (result.deleted > 0) {
            console.log(`[plugin] deleted ${result.deleted} existing draft(s)`);
          }
        }
      } catch (delErr) {
        // Non bloquant : on continue même si la suppression échoue
        console.warn('[plugin] delete-drafts failed:', delErr);
      }

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

      // Figer le contenu : le bloc ne changera plus
      setPushedContent(cleaned);
      setPushed(true);
    } catch (err) {
      console.error('[plugin] createDraft error:', err);
      setError(err instanceof Error ? err.message : 'Erreur lors du push');
    } finally {
      setPushing(false);
    }
  }

  // Mode figé après push
  if (pushed) {
    return (
      <div className="draft-final draft-final-pushed">
        <div className="draft-final-header">Brouillon poussé dans Front App</div>
        <div className="draft-final-content">{pushedContent}</div>
        <p style={{ color: 'var(--success)', fontSize: '12px', marginTop: '8px' }}>
          Visible dans le fil de conversation. Vous pouvez le modifier et l'envoyer depuis Front App.
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
