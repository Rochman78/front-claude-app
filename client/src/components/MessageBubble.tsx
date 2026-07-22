import { useState } from 'react';
import { splitAssistantMessage } from '../utils/splitAssistantMessage';

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** ISO 8601 timestamp du BDD claude_messages.created_at.
   *  Optionnel : les messages fraîchement générés côté client (streaming)
   *  n'en ont pas. Utilisé par la détection auto-reset (nouveau mail
   *  client arrivé après notre dernier brouillon). */
  createdAt?: string;
}

interface MessageBubbleProps {
  message: Message;
}

function isSectionTitle(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  // Lignes markdown bold : **TITRE**
  if (/^\*\*[^*]+\*\*$/.test(trimmed)) return true;
  // Lignes entièrement en majuscules (min 3 chars, pas de minuscules)
  if (trimmed.length >= 3 && /^[A-ZÀ-Ü0-9\s:—–\-/]+$/.test(trimmed)) return true;
  return false;
}

function formatContent(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      if (isSectionTitle(line)) {
        // Retirer les ** si présents
        const clean = line.trim().replace(/^\*\*|\*\*$/g, '');
        return `<div class="section-title">${clean}</div>`;
      }
      // Markdown bold **texte**
      let html = line.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      // Markdown italic *texte* (pas les **)
      html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
      return html;
    })
    .join('<br>');
}

/**
 * Rendu d'un message assistant Claude, SÉPARÉ en 3 panneaux distincts :
 *   1. Brouillon (bleu clair — le mail au client)
 *   2. Vérification (vert d'eau — bloc informatif interne)
 *   3. Points bloquants / Questions (orange — action requise du gérant)
 *
 * Objectif Charles 15/07/2026 (cnv_1lwmc8d3) : le brouillon ne doit
 * JAMAIS être visuellement mélangé avec les questions internes, pour éviter
 * qu'un push accidentel n'envoie les QUESTIONS au client.
 * L'intro (raisonnement Claude, ex. INVENTAIRE DU CROQUIS) est repliée par
 * défaut et dépliable via un lien discret.
 */
function AssistantSplitView({ content }: { content: string }) {
  const [showIntro, setShowIntro] = useState(false);
  const split = splitAssistantMessage(content);

  // Fallback : si le parser n'a pas trouvé de structure claire, on affiche
  // en mode legacy (une seule bulle). Évite de casser les messages atypiques
  // (raw stream tronqué, ancien format, réponse hors-schéma).
  if (!split.hasStructure) {
    return (
      <div
        className="message-content"
        dangerouslySetInnerHTML={{ __html: formatContent(content) }}
      />
    );
  }

  return (
    <div className="assistant-split">
      {split.intro && (
        <div className="assistant-intro">
          <button
            type="button"
            className="assistant-intro-toggle"
            onClick={() => setShowIntro((v) => !v)}
          >
            {showIntro ? '▾' : '▸'} Analyse Claude (interne)
          </button>
          {showIntro && (
            <div
              className="assistant-intro-body"
              dangerouslySetInnerHTML={{ __html: formatContent(split.intro) }}
            />
          )}
        </div>
      )}

      {split.draft && (
        <div className="assistant-block assistant-draft">
          <div className="assistant-block-header">📧 Brouillon (mail au client)</div>
          <div
            className="assistant-block-body"
            dangerouslySetInnerHTML={{ __html: formatContent(split.draft) }}
          />
        </div>
      )}

      {split.verification && (
        <div className="assistant-block assistant-verification">
          <div className="assistant-block-header">✅ Vérification (interne)</div>
          <div
            className="assistant-block-body"
            dangerouslySetInnerHTML={{ __html: formatContent(split.verification) }}
          />
        </div>
      )}

      {split.questions && (
        <div className="assistant-block assistant-questions">
          <div className="assistant-block-header">❗ Points bloquants / Questions (JAMAIS envoyé au client)</div>
          <div
            className="assistant-block-body"
            dangerouslySetInnerHTML={{ __html: formatContent(split.questions) }}
          />
        </div>
      )}
    </div>
  );
}

export default function MessageBubble({ message }: MessageBubbleProps) {
  return (
    <div className={`message-bubble ${message.role}`}>
      <div className="message-role">
        {message.role === 'assistant' ? 'Claude' : 'Vous'}
      </div>
      {message.role === 'assistant' ? (
        <AssistantSplitView content={message.content} />
      ) : (
        <div className="message-content">{message.content}</div>
      )}
    </div>
  );
}
