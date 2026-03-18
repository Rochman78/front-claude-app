'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Agent } from '@/types';
import { getAgents } from '@/lib/storage';

export default function MailboxPage() {
  const [agents, setAgents] = useState<Agent[]>([]);

  useEffect(() => {
    setAgents(getAgents());
  }, []);

  return (
    <div className="max-w-3xl mx-auto py-6">
      <h1 className="text-2xl font-bold text-white mb-6">Boîte Mail</h1>
      <p className="text-gray-400 mb-6">Sélectionnez un agent pour accéder à sa boîte mail.</p>

      {agents.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          Aucun agent créé. Allez dans{' '}
          <Link href="/admin/agents" className="text-blue-400 hover:underline">
            Administration &gt; Agents
          </Link>{' '}
          pour en créer un.
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {agents.map((agent) => (
            <Link
              key={agent.id}
              href={`/mailbox/${agent.id}`}
              className="rounded-xl bg-gray-800 p-6 border border-gray-700 hover:border-blue-500 transition-colors"
            >
              <div className="font-semibold text-white text-lg">{agent.name}</div>
              <div className="text-sm text-gray-400 mt-1">{agent.email}</div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
