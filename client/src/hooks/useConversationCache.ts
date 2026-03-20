import { useRef, useCallback } from 'react';
import type { Message } from '../components/MessageBubble';

const API_BASE = window.location.origin;

interface CachedConversation {
  conversationId: string;
  messages: Message[];
}

/**
 * Cache mémoire des conversations Claude.
 * Persiste entre les changements de mail (tant que le plugin reste ouvert).
 * Clé = frontConversationId.
 */
export function useConversationCache() {
  const cache = useRef<Map<string, CachedConversation>>(new Map());

  /** Récupère une conversation depuis le cache mémoire */
  const getFromCache = useCallback((frontConvId: string): CachedConversation | null => {
    return cache.current.get(frontConvId) || null;
  }, []);

  /** Sauvegarde une conversation dans le cache mémoire */
  const setInCache = useCallback((frontConvId: string, data: CachedConversation) => {
    cache.current.set(frontConvId, data);
  }, []);

  /** Charge une conversation depuis la BDD (si pas en cache) */
  const loadFromDB = useCallback(async (frontConvId: string, storeCode: string): Promise<CachedConversation | null> => {
    try {
      const res = await fetch(
        `${API_BASE}/api/plugin/conversation?front_conversation_id=${encodeURIComponent(frontConvId)}&store_code=${encodeURIComponent(storeCode)}`
      );
      if (!res.ok) return null;
      const data = await res.json();
      if (!data || !data.messages || data.messages.length === 0) return null;

      const cached: CachedConversation = {
        conversationId: data.conversationId,
        messages: data.messages.map((m: { id: string; role: string; content: string }) => ({
          id: m.id,
          role: m.role as 'user' | 'assistant',
          content: m.content,
        })),
      };

      // Mettre en cache
      cache.current.set(frontConvId, cached);
      return cached;
    } catch (err) {
      console.error('[cache] loadFromDB error:', err);
      return null;
    }
  }, []);

  return { getFromCache, setInCache, loadFromDB };
}
