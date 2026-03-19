export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

interface MessageBubbleProps {
  message: Message;
}

export default function MessageBubble({ message }: MessageBubbleProps) {
  return (
    <div className={`message-bubble ${message.role}`}>
      <div className="message-role">
        {message.role === 'assistant' ? 'Claude' : 'Vous'}
      </div>
      <div className="message-content">{message.content}</div>
    </div>
  );
}
