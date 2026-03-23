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

/** Hook exposant la logique push pour que PluginMain place le bouton où il veut */
export function usePushDraft(context: FrontSingleConversationContext) {
  const [pushing, setPushing] = useState(false);
  const [pushSuccess, setPushSuccess] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);

  async function handlePush(cleaned: string, pdfUrl?: string, quoteNumber?: string) {
    setPushing(true);
    setPushError(null);
    setPushSuccess(false);

    try {
      if (pdfUrl) {
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
        const convType = (context.conversation as Record<string, unknown>).type ?? 'unknown';
        const convId = context.conversation.id;
        console.log('[push] conversation type:', convType, 'id:', convId);
        const useSDK = convType === 'email';
        console.log('[push] strategy:', useSDK ? 'SDK createDraft (email)' : 'REST backend (non-email)');

        if (!useSDK) {
          console.log('[push] step 1: calling push-draft REST for non-email');
          const response = await fetch(`${API_BASE}/api/plugin/push-draft`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ conversationId: convId, body: textToHtml(cleaned) }),
          });
          const responseText = await response.text();
          console.log('[push] step 2: push-draft response status:', response.status);
          console.log('[push] step 3: push-draft response body:', responseText);
          if (!response.ok) {
            const err = responseText ? JSON.parse(responseText) : {};
            throw new Error(err.error || `Erreur ${response.status}`);
          }
          console.log('[push] step 4: draft created via REST');
        } else {
          console.log('[push] step 1: calling delete-drafts');
          const delRes = await fetch(`${API_BASE}/api/plugin/delete-drafts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ conversationId: convId }),
          });
          const delData = delRes.ok ? await delRes.json() : null;
          console.log('[push] step 2: delete-drafts done, result:', delData);

          if (delData && delData.deleted > 0) {
            console.log('[push] step 3: waiting 500ms for Front App to process deletion...');
            await new Promise((r) => setTimeout(r, 500));
          } else {
            console.log('[push] step 3: no drafts deleted, skipping wait');
          }

          console.log('[push] step 4: about to create draft via SDK createDraft');
          const messagesResponse = await context.listMessages();
          const messages = messagesResponse.results;
          console.log('[push] step 4b: got', messages.length, 'messages');

          if (messages.length === 0) {
            throw new Error('Aucun message dans la conversation');
          }

          const latestMessageId = messages[messages.length - 1].id;
          console.log('[push] step 4c: replying to message:', latestMessageId);

          await context.createDraft({
            content: { body: textToHtml(cleaned), type: 'html' },
            replyOptions: { type: 'reply', originalMessageId: latestMessageId },
          });
          console.log('[push] step 5: draft created via SDK');
        }
      }

      setPushSuccess(true);
      setTimeout(() => setPushSuccess(false), 3000);
    } catch (err) {
      console.error('[plugin] push draft error:', err);
      setPushError(err instanceof Error ? err.message : 'Erreur lors du push');
    } finally {
      setPushing(false);
    }
  }

  return { handlePush, pushing, pushSuccess, pushError };
}

/** Composant texte uniquement (fond vert) — les boutons sont dans PluginMain */
export default function DraftFinal({ rawContent, pdfUrl, skipClean, pushError, pushSuccess }: DraftFinalProps & { pushError?: string | null; pushSuccess?: boolean }) {
  const cleaned = skipClean ? rawContent : cleanDraft(rawContent);

  return (
    <div className="draft-final-text">
      <div className="draft-final-header">Mail final</div>
      <div className="draft-final-content">{cleaned}</div>
      {pdfUrl && (
        <p style={{ fontSize: '11px', color: 'var(--primary)', marginTop: '8px' }}>
          Le devis PDF sera joint automatiquement au brouillon.
        </p>
      )}
      {pushError && (
        <p style={{ color: 'var(--error)', fontSize: '12px', marginTop: '8px' }}>{pushError}</p>
      )}
      {pushSuccess && (
        <p style={{ color: 'var(--success)', fontSize: '12px', marginTop: '8px' }}>
          Brouillon poussé dans Front App{pdfUrl ? ' avec le PDF en pièce jointe' : ''}.
        </p>
      )}
    </div>
  );
}
