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
    author?: { email?: string };
    body?: string;
  };
  recipient: {
    handle: string;
    name?: string;
  };
}

export default function AgentMailboxPage() {
  const { agentId } = useParams<{ agentId: string }>();
  const [agent, setAgent] = useState<Agent | null>(null);
  const [conversations, setConversations] = useState<FrontConversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const load = async () => {
      const a = await getAgent(agentId);
      if (!a) return;
      setAgent(a);

      if (!a.inboxId) {
        setError('Cet agent n\'a pas de boîte mail FrontApp associée.');
        setLoading(false);
        return;
      }

      try {
        const res = await fetch(`/api/frontapp/threads?inbox_id=${a.inboxId}`);
        const data = await res.json();
        if (data.error) {
          setError(data.error);
        } else {
          setConversations(data._results || []);
        }
      } catch {
        setError('Erreur de connexion à FrontApp');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [agentId]);

  if (!agent) {
    return <div className="py-10 text-center text-gray-500">Agent introuvable</div>;
  }

  return (
    <div className="max-w-4xl mx-auto py-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Boîte mail — {agent.name}</h1>
        <p className="text-gray-400">{agent.email}</p>
      </div>

      {loading ? (
        <div className="text-center py-12 text-gray-500">Chargement des conversations...</div>
      ) : error ? (
        <div className="text-center py-12 text-red-400">{error}</div>
      ) : conversations.length === 0 ? (
        <div className="text-center py-12 text-gray-500">Aucune conversation non archivée dans cette boîte mail.</div>
      ) : (
        <div className="flex flex-col gap-3">
          {conversations.map((conv) => (
            <Link
              key={conv.id}
              href={`/mailbox/${agentId}/thread/${conv.id}`}
              className="rounded-xl bg-gray-800 p-4 border border-gray-700 hover:border-blue-500 transition-colors"
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="font-semibold text-white">
                    {conv.subject || '(Sans sujet)'}
                  </div>
                  <div className="text-sm text-gray-400 mt-1">
                    {conv.recipient?.name || conv.recipient?.handle || 'Inconnu'}
                  </div>
                  <div className="flex items-center gap-2 mt-1">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${
                      conv.status === 'unassigned'
                        ? 'bg-yellow-600/20 text-yellow-400'
                        : 'bg-blue-600/20 text-blue-400'
                    }`}>
                      {conv.status === 'unassigned' ? 'Non assigné' : 'Assigné'}
                    </span>
                  </div>
                </div>
                <div className="text-xs text-gray-500">
                  {conv.last_message?.created_at
                    ? new Date(conv.last_message.created_at * 1000).toLocaleDateString('fr-FR')
                    : ''}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
