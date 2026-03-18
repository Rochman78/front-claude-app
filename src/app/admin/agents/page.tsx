'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Agent } from '@/types';
import { getAgents, createAgent, deleteAgent } from '@/lib/storage';

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [showForm, setShowForm] = useState(false);

  useEffect(() => {
    setAgents(getAgents());
  }, []);

  const handleCreate = () => {
    if (!name.trim() || !email.trim()) return;
    createAgent(name.trim(), email.trim());
    setAgents(getAgents());
    setName('');
    setEmail('');
    setShowForm(false);
  };

  const handleDelete = (id: string) => {
    if (!confirm('Supprimer cet agent ?')) return;
    deleteAgent(id);
    setAgents(getAgents());
  };

  return (
    <div className="max-w-3xl mx-auto py-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-white">Gestion des agents</h1>
        <button
          onClick={() => setShowForm(!showForm)}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 transition-colors"
        >
          {showForm ? 'Annuler' : '+ Nouvel agent'}
        </button>
      </div>

      {showForm && (
        <div className="mb-6 rounded-xl bg-gray-800 p-6 border border-gray-700">
          <h2 className="text-lg font-semibold text-white mb-4">Créer un agent</h2>
          <div className="flex flex-col gap-3">
            <input
              type="text"
              placeholder="Nom de l'agent"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="rounded-lg bg-gray-900 border border-gray-600 px-4 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
            />
            <input
              type="email"
              placeholder="Email de l'agent"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="rounded-lg bg-gray-900 border border-gray-600 px-4 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
            />
            <button
              onClick={handleCreate}
              className="rounded-lg bg-green-600 px-4 py-2 text-sm font-semibold text-white hover:bg-green-700 transition-colors self-end"
            >
              Créer
            </button>
          </div>
        </div>
      )}

      {agents.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          Aucun agent créé. Cliquez sur &quot;+ Nouvel agent&quot; pour commencer.
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {agents.map((agent) => (
            <div
              key={agent.id}
              className="flex items-center justify-between rounded-xl bg-gray-800 p-4 border border-gray-700 hover:border-gray-600 transition-colors"
            >
              <Link href={`/admin/agents/${agent.id}`} className="flex-1">
                <div className="font-semibold text-white">{agent.name}</div>
                <div className="text-sm text-gray-400">{agent.email}</div>
              </Link>
              <button
                onClick={() => handleDelete(agent.id)}
                className="rounded-lg bg-red-600/20 px-3 py-1 text-sm text-red-400 hover:bg-red-600/40 transition-colors"
              >
                Supprimer
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
