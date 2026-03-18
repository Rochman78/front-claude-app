'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Agent, FrontInbox } from '@/types';
import { getAgents, createAgent, deleteAgent } from '@/lib/storage';

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [inboxes, setInboxes] = useState<FrontInbox[]>([]);
  const [selectedInboxId, setSelectedInboxId] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [loadingInboxes, setLoadingInboxes] = useState(false);

  const loadAgents = async () => {
    setAgents(await getAgents());
  };

  useEffect(() => {
    loadAgents();
  }, []);

  const loadInboxes = async () => {
    setLoadingInboxes(true);
    try {
      const res = await fetch('/api/frontapp/inboxes');
      const data = await res.json();
      if (data.error) {
        alert(`Erreur FrontApp: ${data.error}`);
        return;
      }
      setInboxes(data);
    } catch {
      alert('Erreur de connexion à FrontApp');
    } finally {
      setLoadingInboxes(false);
    }
  };

  const handleShowForm = () => {
    if (!showForm) {
      loadInboxes();
    }
    setShowForm(!showForm);
    setSelectedInboxId('');
  };

  const handleCreate = async () => {
    const inbox = inboxes.find((i) => i.id === selectedInboxId);
    if (!inbox) return;

    // Filter out inboxes already used by an agent
    const existingInboxIds = agents.map((a) => a.inboxId);
    if (existingInboxIds.includes(inbox.id)) {
      alert('Cette boîte mail est déjà associée à un agent.');
      return;
    }

    await createAgent(inbox.name, inbox.address || '', inbox.id);
    await loadAgents();
    setSelectedInboxId('');
    setShowForm(false);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Supprimer cet agent ?')) return;
    await deleteAgent(id);
    await loadAgents();
  };

  // Filter out inboxes already assigned to an agent
  const usedInboxIds = agents.map((a) => a.inboxId);
  const availableInboxes = inboxes.filter((i) => !usedInboxIds.includes(i.id));

  return (
    <div className="max-w-3xl mx-auto py-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-white">Gestion des agents</h1>
        <button
          onClick={handleShowForm}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 transition-colors"
        >
          {showForm ? 'Annuler' : '+ Nouvel agent'}
        </button>
      </div>

      {showForm && (
        <div className="mb-6 rounded-xl bg-gray-800 p-6 border border-gray-700">
          <h2 className="text-lg font-semibold text-white mb-4">Créer un agent depuis une boîte mail</h2>
          {loadingInboxes ? (
            <p className="text-gray-400">Chargement des boîtes mail FrontApp...</p>
          ) : availableInboxes.length === 0 ? (
            <p className="text-gray-500">
              {inboxes.length === 0
                ? 'Aucune boîte mail trouvée. Vérifiez que FRONT_API_TOKEN est configuré.'
                : 'Toutes les boîtes mail sont déjà associées à un agent.'}
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              <label className="text-sm font-medium text-gray-300">Sélectionnez une boîte mail :</label>
              <select
                value={selectedInboxId}
                onChange={(e) => setSelectedInboxId(e.target.value)}
                className="rounded-lg bg-gray-900 border border-gray-600 px-4 py-2 text-white focus:outline-none focus:border-blue-500"
              >
                <option value="">-- Choisir une boîte mail --</option>
                {availableInboxes.map((inbox) => (
                  <option key={inbox.id} value={inbox.id}>
                    {inbox.name} {inbox.address ? `(${inbox.address})` : ''}
                  </option>
                ))}
              </select>
              <button
                onClick={handleCreate}
                disabled={!selectedInboxId}
                className="rounded-lg bg-green-600 px-4 py-2 text-sm font-semibold text-white hover:bg-green-700 transition-colors self-end disabled:opacity-50"
              >
                Créer l&apos;agent
              </button>
            </div>
          )}
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
