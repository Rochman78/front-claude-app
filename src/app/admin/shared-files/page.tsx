'use client';

import { useState, useEffect } from 'react';
import { SharedFile, Agent } from '@/types';
import { getSharedFiles, addSharedFile, deleteSharedFile, getAgents } from '@/lib/storage';

export default function SharedFilesPage() {
  const [files, setFiles] = useState<SharedFile[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [fileName, setFileName] = useState('');
  const [fileContent, setFileContent] = useState('');
  const [assignMode, setAssignMode] = useState<'all' | 'specific'>('all');
  const [selectedAgents, setSelectedAgents] = useState<string[]>([]);

  const loadData = async () => {
    setFiles(await getSharedFiles());
    setAgents(await getAgents());
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleAdd = async () => {
    if (!fileName.trim() || !fileContent.trim()) return;
    const file: SharedFile = {
      id: crypto.randomUUID(),
      name: fileName.trim(),
      content: fileContent.trim(),
      assignedTo: assignMode === 'all' ? 'all' : selectedAgents,
      createdAt: new Date().toISOString(),
    };
    await addSharedFile(file);
    await loadData();
    setFileName('');
    setFileContent('');
    setSelectedAgents([]);
    setAssignMode('all');
    setShowForm(false);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Supprimer ce fichier partagé ?')) return;
    await deleteSharedFile(id);
    await loadData();
  };

  const toggleAgent = (agentId: string) => {
    setSelectedAgents((prev) =>
      prev.includes(agentId) ? prev.filter((id) => id !== agentId) : [...prev, agentId]
    );
  };

  const getAssignLabel = (file: SharedFile) => {
    if (file.assignedTo === 'all') return 'Tous les agents';
    const names = (file.assignedTo as string[])
      .map((id) => agents.find((a) => a.id === id)?.name)
      .filter(Boolean);
    return names.join(', ') || 'Aucun agent';
  };

  return (
    <div className="max-w-3xl mx-auto py-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-white">Fichiers partagés</h1>
        <button
          onClick={() => setShowForm(!showForm)}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 transition-colors"
        >
          {showForm ? 'Annuler' : '+ Ajouter un fichier'}
        </button>
      </div>

      {showForm && (
        <div className="mb-6 rounded-xl bg-gray-800 p-6 border border-gray-700">
          <h2 className="text-lg font-semibold text-white mb-4">Nouveau fichier partagé</h2>
          <div className="flex flex-col gap-3">
            <input
              type="text"
              placeholder="Nom du fichier"
              value={fileName}
              onChange={(e) => setFileName(e.target.value)}
              className="rounded-lg bg-gray-900 border border-gray-600 px-4 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
            />
            <textarea
              placeholder="Contenu du fichier"
              value={fileContent}
              onChange={(e) => setFileContent(e.target.value)}
              rows={6}
              className="rounded-lg bg-gray-900 border border-gray-600 px-4 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 resize-y"
            />

            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium text-gray-300">Assigner à :</label>
              <div className="flex gap-4">
                <label className="flex items-center gap-2 text-sm text-gray-300">
                  <input
                    type="radio"
                    checked={assignMode === 'all'}
                    onChange={() => setAssignMode('all')}
                    className="accent-blue-500"
                  />
                  Tous les agents
                </label>
                <label className="flex items-center gap-2 text-sm text-gray-300">
                  <input
                    type="radio"
                    checked={assignMode === 'specific'}
                    onChange={() => setAssignMode('specific')}
                    className="accent-blue-500"
                  />
                  Agents spécifiques
                </label>
              </div>

              {assignMode === 'specific' && (
                <div className="flex flex-col gap-2 mt-2 pl-2">
                  {agents.length === 0 ? (
                    <span className="text-sm text-gray-500">Aucun agent créé</span>
                  ) : (
                    agents.map((agent) => (
                      <label key={agent.id} className="flex items-center gap-2 text-sm text-gray-300">
                        <input
                          type="checkbox"
                          checked={selectedAgents.includes(agent.id)}
                          onChange={() => toggleAgent(agent.id)}
                          className="accent-blue-500"
                        />
                        {agent.name} ({agent.email})
                      </label>
                    ))
                  )}
                </div>
              )}
            </div>

            <button
              onClick={handleAdd}
              className="rounded-lg bg-green-600 px-4 py-2 text-sm font-semibold text-white hover:bg-green-700 transition-colors self-end"
            >
              Ajouter
            </button>
          </div>
        </div>
      )}

      {files.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          Aucun fichier partagé. Cliquez sur &quot;+ Ajouter un fichier&quot; pour commencer.
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {files.map((file) => (
            <div
              key={file.id}
              className="rounded-xl bg-gray-800 p-4 border border-gray-700"
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="font-semibold text-white">{file.name}</div>
                  <div className="text-sm text-gray-400 mt-1">Assigné à : {getAssignLabel(file)}</div>
                  <pre className="mt-2 text-xs text-gray-400 bg-gray-900 rounded-lg p-3 max-h-32 overflow-auto whitespace-pre-wrap">
                    {file.content}
                  </pre>
                </div>
                <button
                  onClick={() => handleDelete(file.id)}
                  className="ml-4 rounded-lg bg-red-600/20 px-3 py-1 text-sm text-red-400 hover:bg-red-600/40 transition-colors"
                >
                  Supprimer
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
