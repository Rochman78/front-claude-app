export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
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

export default function MessageBubble({ message }: MessageBubbleProps) {
  return (
    <div className={`message-bubble ${message.role}`}>
      <div className="message-role">
        {message.role === 'assistant' ? 'Claude' : 'Vous'}
      </div>
      {message.role === 'assistant' ? (
        <div className="message-content" dangerouslySetInnerHTML={{ __html: formatContent(message.content) }} />
      ) : (
        <div className="message-content">{message.content}</div>
      )}
    </div>
  );
}
