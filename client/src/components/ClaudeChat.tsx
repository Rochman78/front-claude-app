import { useRef, useEffect } from 'react';
import MessageBubble, { type Message } from './MessageBubble';
import InputBar from './InputBar';

interface ClaudeChatProps {
  messages: Message[];
  streamingContent: string;
  isStreaming: boolean;
  onSend: (message: string) => void;
}

export default function ClaudeChat({ messages, streamingContent, isStreaming, onSend }: ClaudeChatProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll vers le bas à chaque nouveau message ou chunk de streaming
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, streamingContent]);

  // Filtrer les messages techniques (contexte mail envoyé au backend)
  const visibleMessages = messages.filter((msg) => {
    if (msg.role === 'user') {
      const text = msg.content.toLowerCase();
      if (
        text.includes('voici le fil de mails du client') ||
        text.includes('[analyse demandée pour') ||
        text.includes('analyse demandée pour')
      ) {
        return false;
      }
    }
    return true;
  });

  console.log('[chat] messages:', messages.length, 'visible:', visibleMessages.length);

  return (
    <>
      <div className="chat-messages">
        {visibleMessages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}

        {/* Bulle de streaming en cours */}
        {isStreaming && streamingContent && (
          <div className="message-bubble assistant">
            <div className="message-role">Claude</div>
            <div className="message-content">{streamingContent}</div>
          </div>
        )}

        {/* Indicateur de chargement initial (avant le premier token) */}
        {isStreaming && !streamingContent && (
          <div className="message-bubble assistant">
            <div className="message-role">Claude</div>
            <div className="message-content streaming-dots">
              <span className="dot" /><span className="dot" /><span className="dot" />
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      <InputBar onSend={onSend} disabled={isStreaming} />
    </>
  );
}
