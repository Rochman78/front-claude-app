'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Agent } from '@/types';
import { getAgent } from '@/lib/storage';

interface FrontConversation {
  id: string;
  subject: string;
  status: string;
  last_message: {
    created_at: number;
  };
  recipient: {
    handle: string;
    name?: string;
  };
}

interface ConvMeta {
  summary: string;
  quote_ready: boolean;
  has_draft: boolean;
  loading: boolean;
}

export default function AgentMailboxPage() {
  const { agentId } = useParams<{ agentId: string }>();
  const [agent, setAgent] = useState<Agent | null>(null);
  const [conversations, setConversations] = useState<FrontConversation[]>([]);
  const [meta, setMeta] = useState<Record<string, ConvMeta>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const load = async () => {
      const a = await getAgent(agentId);
      if (!a) return;
      setAgent(a);

      if (!a.inboxId) {
        setError("Cet agent n'a pas de boîte mail FrontApp associée.");
        setLoading(false);
        return;
      }

      try {
        const res = await fetch(`/api/frontapp/threads?inbox_id=${a.inboxId}`);
        const data = await res.json();
        if (data.error) {
          setError(data.error);
        } else {
          const convs: FrontConversation[] = data._results || [];
          setConversations(convs);
          // Init meta with loading state
          const initMeta: Record<string, ConvMeta> = {};
          convs.forEach((c) => { initMeta[c.id] = { summary: '', quote_ready: false, has_draft: false, loading: true }; });
          setMeta(initMeta);
          // Fetch summary + draft for each conversation in parallel
          convs.forEach(async (conv) => {
            const [summaryRes, draftRes] = await Promise.all([
              fetch(`/api/frontapp/summary?conversation_id=${conv.id}`).then((r) => r.json()).catch(() => ({ summary: '', quote_ready: false })),
              fetch(`/api/frontapp/drafts?conversation_id=${conv.id}`).then((r) => r.json()).catch(() => ({ has_draft: false })),
            ]);
            setMeta((prev) => ({
              ...prev,
              [conv.id]: {
                summary: summaryRes.summary || '',
                quote_ready: summaryRes.quote_ready || false,
                has_draft: draftRes.has_draft || false,
                loading: false,
              },
            }));
          });
        }
      } catch {
        setError('Erreur de connexion à FrontApp');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [agentId]);

  const formatDate = (ts: number) =>
    new Date(ts * 1000).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });

  if (!agent) {
    return <div className="py-10 text-center text-gray-500">Agent introuvable</div>;
  }

  return (
    <div className="max-w-4xl mx-auto py-6">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-white">{agent.name}</h1>
        <p className="text-sm text-gray-500">{agent.email}</p>
      </div>

      {loading ? (
        <div className="text-center py-12 text-gray-500">Chargement des conversations...</div>
      ) : error ? (
        <div className="text-center py-12 text-red-400">{error}</div>
      ) : conversations.length === 0 ? (
        <div className="text-center py-12 text-gray-500">Aucune conversation non archivée.</div>
      ) : (
        <div className="flex flex-col divide-y divide-gray-800 rounded-xl overflow-hidden border border-gray-800">
          {conversations.map((conv) => {
            const m = meta[conv.id];
            return (
              <Link
                key={conv.id}
                href={`/mailbox/${agentId}/thread/${conv.id}`}
                className="bg-gray-900 hover:bg-gray-800 px-5 py-4 transition-colors"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    {/* Subject + badges */}
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-white text-sm truncate">
                        {conv.subject || '(Sans sujet)'}
                      </span>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0 ${
                        conv.status === 'unassigned'
                          ? 'bg-yellow-500/20 text-yellow-400'
                          : 'bg-blue-500/20 text-blue-400'
                      }`}>
                        {conv.status === 'unassigned' ? 'Non assigné' : 'Assigné'}
                      </span>
                      {m?.has_draft && (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/20 text-green-400 font-medium flex-shrink-0">
                          brouillon
                        </span>
                      )}
                      {m?.quote_ready && (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-500/20 text-indigo-400 font-medium flex-shrink-0">
                          devis PDF à faire
                        </span>
                      )}
                    </div>
                    {/* Summary */}
                    <div className="text-xs text-gray-500 mt-1 truncate">
                      {m?.loading ? (
                        <span className="inline-block w-32 h-3 bg-gray-700 rounded animate-pulse" />
                      ) : (
                        m?.summary || conv.recipient?.name || conv.recipient?.handle || ''
                      )}
                    </div>
                  </div>
                  {/* Date */}
                  <div className="text-xs text-gray-600 flex-shrink-0">
                    {conv.last_message?.created_at ? formatDate(conv.last_message.created_at) : ''}
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
