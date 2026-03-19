'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Agent } from '@/types';
import { getAgents } from '@/lib/storage';

export default function MailboxPage() {
  const [agents, setAgents] = useState<Agent[]>([]);

  useEffect(() => {
    getAgents().then(setAgents);
  }, []);

  return (
    <div className="max-w-4xl mx-auto py-10">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Boîte Mail</h1>
        <p className="text-sm text-gray-500 mt-1">Sélectionnez un agent pour accéder à sa boîte mail.</p>
      </div>

      {agents.length === 0 ? (
        <div className="text-center py-16 text-gray-400 text-sm">
          Aucun agent créé.{' '}
          <Link href="/admin/agents" className="text-blue-500 hover:underline">
            Créer un agent →
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {agents.map((agent) => (
            <Link
              key={agent.id}
              href={`/mailbox/${agent.id}`}
              className="group rounded-2xl bg-white border border-gray-200 p-6 hover:border-blue-400 hover:shadow-md transition-all"
            >
              <div className="w-10 h-10 rounded-xl bg-gray-900 flex items-center justify-center text-white font-bold text-sm mb-4">
                {agent.name.charAt(0).toUpperCase()}
              </div>
              <div className="font-semibold text-gray-900 text-base leading-tight">{agent.name}</div>
              <div className="text-xs text-gray-400 mt-2 group-hover:text-blue-500 transition-colors">
                Voir les conversations →
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
