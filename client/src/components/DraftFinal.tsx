import { useState } from 'react';
import type { FrontSingleConversationContext } from '../providers/FrontContext';
import { cleanDraft } from '../utils/cleanDraft';
import { textToHtml } from '../utils/textToHtml';

const API_BASE = window.location.origin;

interface DraftFinalProps {
  rawContent: string;
  context: FrontSingleConversationContext;
  pdfUrl?: string;
  quoteNumber?: string;
  skipClean?: boolean;
}

export default function DraftFinal({ rawContent, context, pdfUrl, quoteNumber, skipClean }: DraftFinalProps) {
  const [pushing, setPushing] = useState(false);
  const [pushSuccess, setPushSuccess] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cleaned = skipClean ? rawContent : cleanDraft(rawContent);

  async function handleCopy() {
    await navigator.clipboard.writeText(cleaned);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handlePush() {
    setPushing(true);
    setError(null);
    setPushSuccess(false);

    try {
      if (pdfUrl) {
        // Push via backend avec PDF en pièce jointe
        console.log('[plugin] pushing draft with PDF attachment');
        const response = await fetch(`${API_BASE}/api/plugin/push-draft`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            conversationId: context.conversation.id,
            body: textToHtml(cleaned),
            pdfUrl,
            pdfFilename: quoteNumber ? `Devis-${quoteNumber}.pdf` : 'devis.pdf',
          }),
        });

        if (!response.ok) {
          const err = await response.json();
          throw new Error(err.error || `Erreur ${response.status}`);
        }
        console.log('[plugin] draft with PDF pushed successfully');
      } else {
        // Push via SDK Front (sans pièce jointe)
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
      }

      setPushSuccess(true);
      setTimeout(() => setPushSuccess(false), 3000);
    } catch (err) {
      console.error('[plugin] push draft error:', err);
      setError(err instanceof Error ? err.message : 'Erreur lors du push');
    } finally {
      setPushing(false);
    }
  }

  return (
    <div className="draft-final">
      <div className="draft-final-header">Mail final</div>
      <div className="draft-final-content">{cleaned}</div>

      {pdfUrl && (
        <p style={{ fontSize: '11px', color: 'var(--primary)', marginBottom: '8px' }}>
          Le devis PDF sera joint automatiquement au brouillon.
        </p>
      )}

      {error && (
        <p style={{ color: 'var(--error)', fontSize: '12px', marginBottom: '8px' }}>{error}</p>
      )}

      {pushSuccess && (
        <p style={{ color: 'var(--success)', fontSize: '12px', marginBottom: '8px' }}>
          Brouillon poussé dans Front App{pdfUrl ? ' avec le PDF en pièce jointe' : ''}.
        </p>
      )}

      <div className="draft-final-actions">
        <button className="btn-secondary" onClick={handleCopy}>
          {copied ? 'Copié !' : 'Copier'}
        </button>
        <button className="btn-primary" onClick={handlePush} disabled={pushing} style={{ width: 'auto' }}>
          {pushing ? 'Envoi...' : pdfUrl ? 'Pousser avec PDF' : 'Pousser dans Front App'}
        </button>
      </div>
    </div>
  );
}
