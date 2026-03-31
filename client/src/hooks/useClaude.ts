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
  restore: (msgs: Message[], convId: string) => void;
  reset: () => void;
  abort: () => void;
  setError: (error: string) => void;
  clearError: () => void;
}

export function useClaude(): UseClaudeReturn {
  const [messages, setMessages] = useState<Message[]>([]);
  const [streamingContent, setStreamingContent] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const conversationIdRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const msgIdCounter = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  function nextId(): string {
    return `msg-${++msgIdCounter.current}`;
  }

  /** Annule tout stream en cours */
  function abortCurrent() {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }

  /** Lit un stream texte et accumule les chunks */
  async function readStream(
    response: Response,
    onChunk: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<string> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let full = '';

    // Écouter l'abort pour annuler la lecture
    if (signal) {
      signal.addEventListener('abort', () => reader.cancel(), { once: true });
    }

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        if (chunk.includes('__ERROR__')) {
          const errorMsg = chunk.replace(/.*__ERROR__/, '');
          console.error('[useClaude] stream error received:', errorMsg);
          throw new Error(errorMsg);
        }
        full += chunk;
        onChunk(full);
      }
    } catch (err) {
      if (signal?.aborted) {
        console.log('[useClaude] stream aborted (conversation changed)');
        throw new DOMException('Aborted', 'AbortError');
      }
      throw err;
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
    // Annuler tout stream précédent
    abortCurrent();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsStreaming(true);
    setStreamingContent('');
    setError(null);

    try {
      console.log('[useClaude] fetching /api/plugin/analyze', { API_BASE, params });
      const response = await fetch(`${API_BASE}/api/plugin/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal: controller.signal,
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || `Erreur ${response.status}`);
      }

      // Récupérer le conversationId depuis le header
      const convId = response.headers.get('X-Conversation-Id');
      if (convId) { setConversationId(convId); conversationIdRef.current = convId; }

      const fullText = await readStream(response, setStreamingContent, controller.signal);

      // Vérifier qu'on n'a pas été annulé entre-temps
      if (controller.signal.aborted) return;

      // Ajouter uniquement la réponse Claude (pas le message technique d'analyse)
      setMessages([
        { id: nextId(), role: 'assistant', content: fullText },
      ]);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      if (!controller.signal.aborted) {
        setStreamingContent('');
        setIsStreaming(false);
      }
    }
  }, []);

  const sendMessage = useCallback(async (message: string) => {
    const currentConvId = conversationIdRef.current;
    if (!currentConvId) {
      setError('Pas de conversation active. Lancez une analyse d\'abord.');
      return;
    }

    // Annuler tout stream précédent
    abortCurrent();
    const controller = new AbortController();
    abortRef.current = controller;

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
        body: JSON.stringify({ conversationId: currentConvId, message }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || `Erreur ${response.status}`);
      }

      const fullText = await readStream(response, setStreamingContent, controller.signal);

      if (controller.signal.aborted) return;

      // Ajouter la réponse assistant
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: 'assistant', content: fullText },
      ]);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      if (!controller.signal.aborted) {
        setStreamingContent('');
        setIsStreaming(false);
      }
    }
  }, []);

  /** Restaurer un historique existant (depuis le cache ou la BDD) */
  const restore = useCallback((msgs: Message[], convId: string) => {
    abortCurrent();
    setMessages(msgs);
    setConversationId(convId);
    conversationIdRef.current = convId;
    setStreamingContent('');
    setIsStreaming(false);
    setError(null);
  }, []);

  /** Reset complet (nouveau mail sans historique) */
  const reset = useCallback(() => {
    abortCurrent();
    setMessages([]);
    setConversationId(null);
    conversationIdRef.current = null;
    setStreamingContent('');
    setIsStreaming(false);
    setError(null);
    msgIdCounter.current = 0;
  }, []);

  const exposedSetError = useCallback((msg: string) => setError(msg), []);
  const clearError = useCallback(() => setError(null), []);

  return {
    messages,
    streamingContent,
    isStreaming,
    conversationId,
    error,
    analyze,
    sendMessage,
    restore,
    reset,
    abort: abortCurrent,
    setError: exposedSetError,
    clearError,
  };
}
