import { useCallback } from 'react';
import type { Message } from '../components/MessageBubble';

const API_BASE = window.location.origin;

interface CachedConversation {
  conversationId: string;
  messages: Message[];
}

export interface CachedQuote {
  pdfUrl: string;
  quoteNumber: string;
  pennylaneUrl: string;
}

/**
 * Cache mémoire au niveau module — survit aux mount/unmount des composants.
 * Persiste tant que le plugin (iframe) est ouvert.
 */
const CACHE = new Map<string, CachedConversation>();
const QUOTE_CACHE = new Map<string, CachedQuote>();
const PENDING = new Set<string>();

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

  const getQuoteFromCache = useCallback((frontConvId: string): CachedQuote | null => {
    return QUOTE_CACHE.get(frontConvId) || null;
  }, []);

  const setQuoteInCache = useCallback((frontConvId: string, data: CachedQuote) => {
    QUOTE_CACHE.set(frontConvId, data);
  }, []);

  const clearCache = useCallback((frontConvId: string) => {
    CACHE.delete(frontConvId);
    QUOTE_CACHE.delete(frontConvId);
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
          // Filtrer les messages corrompus (CSS brut) et techniques (analyse demandée)
          .filter((m: { content: string; role: string }) =>
            !m.content.includes('@media screen') &&
            !(m.role === 'user' && m.content.startsWith('[Analyse demandée'))
          )
          .map((m: { id: string; role: string; content: string; createdAt?: string }) => ({
            id: m.id,
            role: m.role as 'user' | 'assistant',
            content: m.content,
            createdAt: m.createdAt,
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

  const deleteFromDB = useCallback(async (frontConvId: string, storeCode: string): Promise<boolean> => {
    try {
      const res = await fetch(
        `${API_BASE}/api/plugin/conversation?front_conversation_id=${encodeURIComponent(frontConvId)}&store_code=${encodeURIComponent(storeCode)}`,
        { method: 'DELETE' }
      );
      clearCache(frontConvId);
      return res.ok;
    } catch {
      return false;
    }
  }, [clearCache]);

  const setPending = useCallback((frontConvId: string) => { PENDING.add(frontConvId); }, []);
  const clearPending = useCallback((frontConvId: string) => { PENDING.delete(frontConvId); }, []);
  const isPending = useCallback((frontConvId: string) => PENDING.has(frontConvId), []);

  return { getFromCache, setInCache, getQuoteFromCache, setQuoteInCache, clearCache, loadFromDB, deleteFromDB, setPending, clearPending, isPending };
}
