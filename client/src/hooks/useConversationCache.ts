import { useCallback } from 'react';
import type { Message } from '../components/MessageBubble';

const API_BASE = window.location.origin;

interface CachedConversation {
  conversationId: string;
  messages: Message[];
}

/**
 * Cache mémoire au niveau module — survit aux mount/unmount des composants.
 * Persiste tant que le plugin (iframe) est ouvert.
 */
const CACHE = new Map<string, CachedConversation>();

export function useConversationCache() {
  const getFromCache = useCallback((frontConvId: string): CachedConversation | null => {
    const cached = CACHE.get(frontConvId) || null;
    if (cached) {
      console.log(`[cache] hit for ${frontConvId}: ${cached.messages.length} msgs`);
    }
    return cached;
  }, []);

  const setInCache = useCallback((frontConvId: string, data: CachedConversation) => {
    CACHE.set(frontConvId, data);
  }, []);

  const loadFromDB = useCallback(async (frontConvId: string, storeCode: string): Promise<CachedConversation | null> => {
    console.log(`[cache] miss, loading from DB ${frontConvId}`);
    try {
      const res = await fetch(
        `${API_BASE}/api/plugin/conversation?front_conversation_id=${encodeURIComponent(frontConvId)}&store_code=${encodeURIComponent(storeCode)}`
      );
      if (!res.ok) return null;
      const data = await res.json();
      if (!data || !data.messages || data.messages.length === 0) return null;

      const cached: CachedConversation = {
        conversationId: data.conversationId,
        messages: data.messages
          // Filtrer les messages corrompus (contiennent du CSS brut)
          .filter((m: { content: string }) => !m.content.includes('@media screen'))
          .map((m: { id: string; role: string; content: string }) => ({
            id: m.id,
            role: m.role as 'user' | 'assistant',
            content: m.content,
          })),
      };

      CACHE.set(frontConvId, cached);
      console.log(`[cache] loaded from DB ${frontConvId}: ${cached.messages.length} msgs`);
      return cached;
    } catch (err) {
      console.error('[cache] loadFromDB error:', err);
      return null;
    }
  }, []);

  return { getFromCache, setInCache, loadFromDB };
}
