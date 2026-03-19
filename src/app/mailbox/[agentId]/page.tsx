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
  last_message: { created_at: number };
  recipient: { handle: string; name?: string };
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
        if (data.error) { setError(data.error); return; }

        const convs: FrontConversation[] = data._results || [];
        setConversations(convs);

        const initMeta: Record<string, ConvMeta> = {};
        convs.forEach((c) => { initMeta[c.id] = { summary: '', quote_ready: false, has_draft: false, loading: true }; });
        setMeta(initMeta);

        convs.forEach(async (conv) => {
          const [s, d] = await Promise.all([
            fetch(`/api/frontapp/summary?conversation_id=${conv.id}`).then((r) => r.json()).catch(() => ({})),
            fetch(`/api/frontapp/drafts?conversation_id=${conv.id}`).then((r) => r.json()).catch(() => ({})),
          ]);
          setMeta((prev) => ({
            ...prev,
            [conv.id]: { summary: s.summary || '', quote_ready: s.quote_ready || false, has_draft: d.has_draft || false, loading: false },
          }));
        });
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

  if (!agent) return <div className="py-10 text-center text-gray-400 text-sm">Agent introuvable</div>;

  return (
    <div className="max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <Link href="/" className="text-xs text-gray-400 hover:text-gray-600 mb-1 inline-block">← Accueil</Link>
          <h1 className="text-lg font-bold text-gray-900">{agent.name}</h1>
        </div>
        <span className="text-xs text-gray-400">{conversations.length} conversation{conversations.length > 1 ? 's' : ''}</span>
      </div>

      {loading ? (
        <div className="text-center py-16 text-gray-400 text-sm">Chargement...</div>
      ) : error ? (
        <div className="text-center py-16 text-red-500 text-sm">{error}</div>
      ) : conversations.length === 0 ? (
        <div className="text-center py-16 text-gray-400 text-sm">Aucune conversation non archivée.</div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          {conversations.map((conv, i) => {
            const m = meta[conv.id];
            const isLast = i === conversations.length - 1;
            return (
              <Link
                key={conv.id}
                href={`/mailbox/${agentId}/thread/${conv.id}`}
                className={`flex items-start gap-4 px-5 py-4 hover:bg-gray-50 transition-colors ${!isLast ? 'border-b border-gray-100' : ''}`}
              >
                {/* Status dot */}
                <div className="mt-1.5 flex-shrink-0">
                  <div className={`w-2 h-2 rounded-full ${conv.status === 'unassigned' ? 'bg-orange-400' : 'bg-gray-300'}`} />
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-0.5">
                    <span className="text-sm font-semibold text-gray-900 truncate">{conv.subject || '(Sans sujet)'}</span>
                    {/* 🟢 Brouillon */}
                    {m?.has_draft && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-green-100 text-green-700 font-medium flex-shrink-0">brouillon</span>
                    )}
                    {/* 🟡 Devis */}
                    {m?.quote_ready && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 font-medium flex-shrink-0">devis à faire</span>
                    )}
                  </div>
                  <div className="text-xs text-gray-400 truncate">
                    {m?.loading ? (
                      <span className="inline-block w-40 h-2.5 bg-gray-100 rounded animate-pulse" />
                    ) : (
                      m?.summary || conv.recipient?.name || (conv.recipient?.handle?.includes('@in.frontapp.com') ? '' : conv.recipient?.handle)
                    )}
                  </div>
                </div>

                {/* Date + status */}
                <div className="flex-shrink-0 text-right">
                  <div className="text-xs text-gray-400">
                    {conv.last_message?.created_at ? formatDate(conv.last_message.created_at) : ''}
                  </div>
                  <div className={`text-xs mt-0.5 ${conv.status === 'unassigned' ? 'text-orange-500' : 'text-gray-400'}`}>
                    {conv.status === 'unassigned' ? 'Non assigné' : 'Assigné'}
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
