'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import { Agent, AgentFile, SharedFile } from '@/types';
import { getAgent, updateAgent, getSharedFilesForAgent } from '@/lib/storage';

type Tab = 'instructions' | 'knowledge';

export default function AgentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [agent, setAgent] = useState<Agent | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>('instructions');
  const [instructions, setInstructions] = useState('');
  const [sharedFiles, setSharedFiles] = useState<SharedFile[]>([]);
  const [newFileName, setNewFileName] = useState('');
  const [newFileContent, setNewFileContent] = useState('');
  const [showFileForm, setShowFileForm] = useState(false);
  const [uploadError, setUploadError] = useState('');

  useEffect(() => {
    const load = async () => {
      const a = await getAgent(id);
      if (a) {
        setAgent(a);
        setInstructions(a.instructions);
        setSharedFiles(await getSharedFilesForAgent(id));
      }
    };
    load();
  }, [id]);

  const saveInstructions = async () => {
    if (!agent) return;
    const updated = { ...agent, instructions };
    await updateAgent(updated);
    setAgent(updated);
  };

  const addFile = async () => {
    if (!agent || !newFileName.trim() || !newFileContent.trim()) return;
    const name = newFileName.trim();

    if (agent.files.some((f) => f.name === name)) {
      setUploadError(`Un fichier "${name}" existe déjà.`);
      return;
    }

    const file: AgentFile = {
      id: crypto.randomUUID(),
      name,
      content: newFileContent.trim(),
      createdAt: new Date().toISOString(),
    };
    const updated = { ...agent, files: [...agent.files, file] };
    await updateAgent(updated);
    setAgent(updated);
    setNewFileName('');
    setNewFileContent('');
    setShowFileForm(false);
    setUploadError('');
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0 || !agent) return;

    const readFile = (file: File): Promise<AgentFile> =>
      new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (ev) => {
          resolve({
            id: crypto.randomUUID(),
            name: file.name,
            content: ev.target?.result as string,
            createdAt: new Date().toISOString(),
          });
        };
        reader.onerror = reject;
        reader.readAsText(file);
      });

    const newFiles = await Promise.all(Array.from(files).map(readFile));

    // Filter out duplicates by name
    const existingNames = new Set(agent.files.map((f) => f.name));
    const duplicates = newFiles.filter((f) => existingNames.has(f.name));
    const unique = newFiles.filter((f) => !existingNames.has(f.name));

    if (duplicates.length > 0) {
      setUploadError(`Fichiers ignorés (déjà existants) : ${duplicates.map((f) => f.name).join(', ')}`);
    } else {
      setUploadError('');
    }

    if (unique.length > 0) {
      const updated = { ...agent, files: [...agent.files, ...unique] };
      await updateAgent(updated);
      setAgent(updated);
    }

    e.target.value = '';
  };

  const deleteFile = async (fileId: string) => {
    if (!agent) return;
    const updated = { ...agent, files: agent.files.filter((f) => f.id !== fileId) };
    await updateAgent(updated);
    setAgent(updated);
  };

  if (!agent) {
    return <div className="py-10 text-center text-gray-500">Agent introuvable</div>;
  }

  const tabs: { key: Tab; label: string }[] = [
    { key: 'instructions', label: 'Instructions' },
    { key: 'knowledge', label: 'Base de connaissances' },
  ];

  return (
    <div className="max-w-4xl mx-auto py-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">{agent.name}</h1>
        <p className="text-gray-400">{agent.email}</p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 border-b border-gray-700">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              activeTab === tab.key
                ? 'border-blue-500 text-blue-400'
                : 'border-transparent text-gray-400 hover:text-gray-200'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Instructions Tab */}
      {activeTab === 'instructions' && (
        <div className="rounded-xl bg-gray-800 p-6 border border-gray-700">
          <h2 className="text-lg font-semibold text-white mb-3">Instructions personnalisées</h2>
          <p className="text-sm text-gray-400 mb-4">
            Ces instructions seront utilisées comme contexte pour toutes les conversations avec cet agent.
          </p>
          <textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            rows={12}
            placeholder="Entrez les instructions pour cet agent... Ex: Tu es un assistant spécialisé dans le support client. Tu dois toujours répondre poliment et proposer des solutions concrètes."
            className="w-full rounded-lg bg-gray-900 border border-gray-600 px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 resize-y"
          />
          <button
            onClick={saveInstructions}
            className="mt-4 rounded-lg bg-blue-600 px-6 py-2 text-sm font-semibold text-white hover:bg-blue-700 transition-colors"
          >
            Sauvegarder
          </button>
        </div>
      )}

      {/* Knowledge Base Tab */}
      {activeTab === 'knowledge' && (
        <div className="space-y-6">
          {/* Agent's own files */}
          <div className="rounded-xl bg-gray-800 p-6 border border-gray-700">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-white">Fichiers de l&apos;agent</h2>
              <div className="flex gap-2">
                <label className="cursor-pointer rounded-lg bg-purple-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-purple-700 transition-colors">
                  Upload
                  <input type="file" className="hidden" onChange={handleFileUpload} multiple />
                </label>
                <button
                  onClick={() => { setShowFileForm(!showFileForm); setUploadError(''); }}
                  className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700 transition-colors"
                >
                  {showFileForm ? 'Annuler' : '+ Manuel'}
                </button>
              </div>
            </div>

            {uploadError && (
              <div className="mb-4 rounded-lg bg-red-600/10 border border-red-600/30 px-4 py-3 text-sm text-red-400">
                {uploadError}
              </div>
            )}

            {showFileForm && (
              <div className="mb-4 flex flex-col gap-3 bg-gray-900 rounded-lg p-4">
                <input
                  type="text"
                  placeholder="Nom du fichier"
                  value={newFileName}
                  onChange={(e) => setNewFileName(e.target.value)}
                  className="rounded-lg bg-gray-950 border border-gray-600 px-4 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                />
                <textarea
                  placeholder="Contenu du fichier"
                  value={newFileContent}
                  onChange={(e) => setNewFileContent(e.target.value)}
                  rows={4}
                  className="rounded-lg bg-gray-950 border border-gray-600 px-4 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 resize-y"
                />
                <button
                  onClick={addFile}
                  className="rounded-lg bg-green-600 px-4 py-2 text-sm font-semibold text-white hover:bg-green-700 transition-colors self-end"
                >
                  Ajouter
                </button>
              </div>
            )}

            {agent.files.length === 0 ? (
              <p className="text-sm text-gray-500">Aucun fichier propre à cet agent.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {agent.files.map((file) => (
                  <div key={file.id} className="flex items-center justify-between bg-gray-900 rounded-lg px-4 py-2">
                    <div>
                      <span className="text-sm font-medium text-white">{file.name}</span>
                      <span className="ml-2 text-xs text-gray-500">{file.content.length} caractères</span>
                    </div>
                    <button
                      onClick={() => deleteFile(file.id)}
                      className="text-xs text-red-400 hover:text-red-300"
                    >
                      Supprimer
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Shared files */}
          <div className="rounded-xl bg-gray-800 p-6 border border-gray-700">
            <h2 className="text-lg font-semibold text-white mb-4">Fichiers partagés</h2>
            {sharedFiles.length === 0 ? (
              <p className="text-sm text-gray-500">Aucun fichier partagé assigné à cet agent.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {sharedFiles.map((file) => (
                  <div key={file.id} className="flex items-center bg-gray-900 rounded-lg px-4 py-2">
                    <span className="text-sm font-medium text-green-400">{file.name}</span>
                    <span className="ml-2 text-xs text-gray-500">{file.content.length} caractères</span>
                    <span className="ml-auto text-xs text-gray-600">partagé</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
