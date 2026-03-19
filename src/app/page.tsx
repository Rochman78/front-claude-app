'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Agent } from '@/types';

interface Inbox {
  id: string;
  name: string;
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
        if (inboxData.error) setError(inboxData.error);
        else setInboxes(inboxData);
        if (Array.isArray(agentData)) setAgents(agentData);
      })
      .catch(() => setError('Erreur de connexion.'))
      .finally(() => setLoading(false));
  }, []);

  const getInitials = (name: string) =>
    name.split(/\s+/).map((w) => w[0]).join('').substring(0, 2).toUpperCase();

  const getAgentForInbox = (inboxId: string) =>
    agents.find((a) => a.inboxId === inboxId);

  if (loading) return (
    <div className="flex items-center justify-center py-24 text-gray-400 text-sm">
      Chargement des boîtes...
    </div>
  );

  if (error) return (
    <div className="text-center py-24 text-red-500 text-sm">{error}</div>
  );

  return (
    <div>
      <p className="text-xs text-gray-400 mb-4">{inboxes.length} boîtes mail</p>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-0 rounded-xl overflow-hidden border border-gray-200">
        {inboxes.map((inbox, i) => {
          const agent = getAgentForInbox(inbox.id);
          const href = agent ? `/mailbox/${agent.id}` : '#';
          return (
            <Link
              key={inbox.id}
              href={href}
              onClick={(e) => !agent && e.preventDefault()}
              className={`bg-white flex flex-col items-center justify-center py-8 px-4 text-center border-gray-200
                ${i % 2 === 0 ? 'border-r' : ''}
                ${i < inboxes.length - 2 ? 'border-b' : ''}
                ${agent ? 'hover:bg-gray-50 cursor-pointer' : 'opacity-40 cursor-not-allowed'}
                transition-colors`}
            >
              <div className="w-10 h-10 rounded-xl bg-gray-900 flex items-center justify-center text-white font-bold text-sm mb-3">
                {getInitials(inbox.name)}
              </div>
              <div className="text-sm font-semibold text-gray-800">{inbox.name}</div>
              {!agent && <div className="text-xs text-gray-400 mt-1">Non configuré</div>}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
