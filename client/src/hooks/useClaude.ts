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
    channel?: string;
    images?: { data: string; mediaType: string; name: string }[];
    skipOversizedCheck?: boolean;
  }) => Promise<void>;
  sendMessage: (message: string) => Promise<void>;
  restore: (msgs: Message[], convId: string, frontConvId: string) => void;
  reset: (frontConvId?: string) => void;
  abort: () => void;
  setError: (error: string) => void;
  clearError: () => void;
  onBackgroundComplete: React.MutableRefObject<((frontConvId: string, convId: string, messages: Message[]) => void) | null>;
}

export function useClaude(): UseClaudeReturn {
  const [messages, _setMessages] = useState<Message[]>([]);
  const [streamingContent, setStreamingContent] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const conversationIdRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const msgIdCounter = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const frontConvIdRef = useRef<string | null>(null);
  const onBackgroundCompleteRef = useRef<((frontConvId: string, convId: string, messages: Message[]) => void) | null>(null);
  const messagesRef = useRef<Message[]>([]);

  // Wrapper setMessages pour garder le ref synchronisé
  function setMessages(update: Message[] | ((prev: Message[]) => Message[])) {
    _setMessages((prev) => {
      const next = typeof update === 'function' ? update(prev) : update;
      messagesRef.current = next;
      return next;
    });
  }

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
    channel?: string;
    images?: { data: string; mediaType: string; name: string }[];
    skipOversizedCheck?: boolean;
  }) => {
    // NE PAS abort le stream précédent — il continue en arrière-plan et sauve en cache via onBackgroundComplete
    // On crée juste un nouveau controller pour ce stream
    const controller = new AbortController();
    abortRef.current = controller;

    // Capturer le frontConversationId au moment du lancement
    const myFrontConvId = params.frontConversationId;
    frontConvIdRef.current = myFrontConvId;

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
      // Ne mettre à jour l'état que si on est toujours sur la même conversation Front
      if (convId && frontConvIdRef.current === myFrontConvId) {
        setConversationId(convId);
        conversationIdRef.current = convId;
      }

      const fullText = await readStream(response, (text) => {
        // Ne mettre à jour le streaming que si on est toujours sur la même conversation Front
        if (frontConvIdRef.current === myFrontConvId) {
          setStreamingContent(text);
        }
      }, controller.signal);

      if (controller.signal.aborted) return;

      const resultMessages: Message[] = [{ id: nextId(), role: 'assistant', content: fullText }];

      if (frontConvIdRef.current === myFrontConvId) {
        // Toujours sur le même mail → mettre à jour l'UI
        setMessages(resultMessages);
      } else if (convId) {
        // Stream terminé en arrière-plan → sauver dans le cache pour quand l'user reviendra
        console.log(`[useClaude] background complete for ${myFrontConvId}, saving to cache`);
        onBackgroundCompleteRef.current?.(myFrontConvId, convId, resultMessages);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (frontConvIdRef.current === myFrontConvId) {
        setError(err instanceof Error ? err.message : 'Erreur inconnue');
      }
    } finally {
      if (!controller.signal.aborted && frontConvIdRef.current === myFrontConvId) {
        setStreamingContent('');
        setIsStreaming(false);
      }
    }
  }, []);

  const sendMessage = useCallback(async (message: string) => {
    const currentConvId = conversationIdRef.current;
    const myFrontConvId = frontConvIdRef.current;
    if (!currentConvId) {
      setError('Pas de conversation active. Lancez une analyse d\'abord.');
      return;
    }

    // NE PAS abort le stream précédent (multitask)
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

      const fullText = await readStream(response, (text) => {
        if (frontConvIdRef.current === myFrontConvId) {
          setStreamingContent(text);
        }
      }, controller.signal);

      if (controller.signal.aborted) return;

      const assistantMsg: Message = { id: nextId(), role: 'assistant', content: fullText };

      if (frontConvIdRef.current === myFrontConvId) {
        // Toujours sur le même mail → mettre à jour l'UI
        setMessages((prev) => [...prev, assistantMsg]);
      } else if (myFrontConvId && currentConvId) {
        // Stream terminé en arrière-plan → sauver dans le cache
        // messagesRef contient déjà le userMsg (ajouté via setMessages plus haut)
        console.log(`[useClaude] sendMessage background complete for ${myFrontConvId}, saving to cache`);
        const fullMessages = [...messagesRef.current, assistantMsg];
        onBackgroundCompleteRef.current?.(myFrontConvId, currentConvId, fullMessages);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (frontConvIdRef.current === myFrontConvId) {
        setError(err instanceof Error ? err.message : 'Erreur inconnue');
      }
    } finally {
      if (!controller.signal.aborted && frontConvIdRef.current === myFrontConvId) {
        setStreamingContent('');
        setIsStreaming(false);
      }
    }
  }, []);

  /** Restaurer un historique existant (depuis le cache ou la BDD) */
  const restore = useCallback((msgs: Message[], convId: string, frontConvId: string) => {
    // NE PAS aborter — le serveur continue et sauve en BDD pour le multitask
    // Setter frontConvIdRef pour que les guards fonctionnent sur sendMessage
    frontConvIdRef.current = frontConvId;
    setMessages(msgs);
    setConversationId(convId);
    conversationIdRef.current = convId;
    setStreamingContent('');
    setIsStreaming(false);
    setError(null);
  }, []);

  /** Reset complet (nouveau mail sans historique) */
  const reset = useCallback((frontConvId?: string) => {
    // NE PAS aborter — même raison que restore (multitask)
    frontConvIdRef.current = frontConvId || null;
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
    onBackgroundComplete: onBackgroundCompleteRef,
  };
}
