'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Agent } from '@/types';

interface Inbox {
  id: string;
  name: string;
  address?: string;
}

export default function Home() {
  const [inboxes, setInboxes] = useState<Inbox[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([
      fetch('/api/frontapp/inboxes').then((r) => r.json()),
      fetch('/api/agents').then((r) => r.json()),
    ])
      .then(([inboxData, agentData]) => {
        if (inboxData.error) {
          setError(inboxData.error);
        } else {
          setInboxes(inboxData);
        }
        if (Array.isArray(agentData)) {
          setAgents(agentData);
        }
      })
      .catch(() => setError('Erreur de connexion. Vérifiez votre token Front.'))
      .finally(() => setLoading(false));
  }, []);

  const getInitials = (name: string) =>
    name
      .split(/\s+/)
      .map((w) => w[0])
      .join('')
      .substring(0, 2)
      .toUpperCase();

  const getAgentForInbox = (inboxId: string) =>
    agents.find((a) => a.inboxId === inboxId);

  return (
    <div className="py-6">
      {loading ? (
        <div className="flex items-center justify-center py-20 text-gray-400">
          <svg className="animate-spin h-5 w-5 mr-3" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          Chargement des boîtes...
        </div>
      ) : error ? (
        <div className="text-center py-20 text-red-400">{error}</div>
      ) : inboxes.length === 0 ? (
        <div className="text-center py-20 text-gray-500">Aucune boîte trouvée.</div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {inboxes.map((inbox) => {
            const agent = getAgentForInbox(inbox.id);
            const href = agent ? `/mailbox/${agent.id}` : '#';

            return (
              <Link
                key={inbox.id}
                href={href}
                className={`group rounded-xl p-6 border transition-all ${
                  agent
                    ? 'bg-gray-800 border-gray-700 hover:border-blue-500 hover:shadow-lg hover:-translate-y-0.5 cursor-pointer'
                    : 'bg-gray-800/50 border-gray-800 opacity-50 cursor-not-allowed'
                }`}
                onClick={(e) => !agent && e.preventDefault()}
              >
                <div className="w-11 h-11 rounded-lg bg-blue-600 flex items-center justify-center mb-3 text-white font-bold text-sm">
                  {getInitials(inbox.name)}
                </div>
                <div className="font-semibold text-white">{inbox.name}</div>
                {!agent && (
                  <div className="text-xs text-gray-500 mt-1">Agent non configuré</div>
                )}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
