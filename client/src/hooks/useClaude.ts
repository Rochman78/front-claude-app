import { useState, useCallback, useRef } from 'react';
import type { Message } from '../components/MessageBubble';

const API_BASE = window.location.origin;

interface UseClaudeReturn {
  messages: Message[];
  streamingContent: string;
  isStreaming: boolean;
  conversationId: string | null;
  error: string | null;
  analyze: (params: {
    storeCode: string;
    customerEmail: string;
    customerName: string;
    mailContent: string;
    frontConversationId: string;
    subject?: string;
  }) => Promise<void>;
  sendMessage: (message: string) => Promise<void>;
  clearError: () => void;
}

export function useClaude(): UseClaudeReturn {
  const [messages, setMessages] = useState<Message[]>([]);
  const [streamingContent, setStreamingContent] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const msgIdCounter = useRef(0);

  function nextId(): string {
    return `msg-${++msgIdCounter.current}`;
  }

  /** Lit un stream texte et accumule les chunks */
  async function readStream(
    response: Response,
    onChunk: (text: string) => void,
  ): Promise<string> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let full = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      if (chunk.startsWith('__ERROR__')) {
        throw new Error(chunk.replace('__ERROR__', ''));
      }
      full += chunk;
      onChunk(full);
    }

    return full;
  }

  const analyze = useCallback(async (params: {
    storeCode: string;
    customerEmail: string;
    customerName: string;
    mailContent: string;
    frontConversationId: string;
    subject?: string;
  }) => {
    setIsStreaming(true);
    setStreamingContent('');
    setError(null);

    try {
      const response = await fetch(`${API_BASE}/api/plugin/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || `Erreur ${response.status}`);
      }

      // Récupérer le conversationId depuis le header
      const convId = response.headers.get('X-Conversation-Id');
      if (convId) setConversationId(convId);

      const fullText = await readStream(response, setStreamingContent);

      // Ajouter le message user (contexte mail) et la réponse assistant
      setMessages([
        { id: nextId(), role: 'user', content: `[Analyse demandée pour ${params.customerName || params.customerEmail}]` },
        { id: nextId(), role: 'assistant', content: fullText },
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setStreamingContent('');
      setIsStreaming(false);
    }
  }, []);

  const sendMessage = useCallback(async (message: string) => {
    if (!conversationId) {
      setError('Pas de conversation active. Lancez une analyse d\'abord.');
      return;
    }

    // Ajouter le message user immédiatement
    const userMsg: Message = { id: nextId(), role: 'user', content: message };
    setMessages((prev) => [...prev, userMsg]);
    setIsStreaming(true);
    setStreamingContent('');
    setError(null);

    try {
      const response = await fetch(`${API_BASE}/api/plugin/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId, message }),
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || `Erreur ${response.status}`);
      }

      const fullText = await readStream(response, setStreamingContent);

      // Ajouter la réponse assistant
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: 'assistant', content: fullText },
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setStreamingContent('');
      setIsStreaming(false);
    }
  }, [conversationId]);

  const clearError = useCallback(() => setError(null), []);

  return {
    messages,
    streamingContent,
    isStreaming,
    conversationId,
    error,
    analyze,
    sendMessage,
    clearError,
  };
}
