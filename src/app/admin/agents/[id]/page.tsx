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

  // Instructions state
  const [instructions, setInstructions] = useState('');
  const [isEditingInstructions, setIsEditingInstructions] = useState(false);
  const [savedInstructions, setSavedInstructions] = useState('');
  const [instructionsSaveStatus, setInstructionsSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');

  // Knowledge base state
  const [sharedFiles, setSharedFiles] = useState<SharedFile[]>([]);
  const [newFileName, setNewFileName] = useState('');
  const [newFileContent, setNewFileContent] = useState('');
  const [showFileForm, setShowFileForm] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [filesSaveStatus, setFilesSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [expandedFileId, setExpandedFileId] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      const a = await getAgent(id);
      if (a) {
        setAgent(a);
        setInstructions(a.instructions);
        setSavedInstructions(a.instructions);
        setSharedFiles(await getSharedFilesForAgent(id));
      }
    };
    load();
  }, [id]);

  // Instructions handlers
  const startEditingInstructions = () => {
    setIsEditingInstructions(true);
    setInstructionsSaveStatus('idle');
  };

  const cancelEditingInstructions = () => {
    setInstructions(savedInstructions);
    setIsEditingInstructions(false);
    setInstructionsSaveStatus('idle');
  };

  const saveInstructions = async () => {
    if (!agent) return;
    setInstructionsSaveStatus('saving');
    const updated = { ...agent, instructions };
    await updateAgent(updated);
    setAgent(updated);
    setSavedInstructions(instructions);
    setIsEditingInstructions(false);
    setInstructionsSaveStatus('saved');
    setTimeout(() => setInstructionsSaveStatus('idle'), 3000);
  };

  // File handlers
  const showFileSaved = () => {
    setFilesSaveStatus('saved');
    setTimeout(() => setFilesSaveStatus('idle'), 3000);
  };

  const addFile = async () => {
    if (!agent || !newFileName.trim() || !newFileContent.trim()) return;
    const name = newFileName.trim();

    if (agent.files.some((f) => f.name === name)) {
      setUploadError(`Un fichier "${name}" existe déjà.`);
      return;
    }

    setFilesSaveStatus('saving');
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
    showFileSaved();
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

    setFilesSaveStatus('saving');
    setUploadError('');

    try {
      const newFiles = await Promise.all(Array.from(files).map(readFile));

      const existingNames = new Set(agent.files.map((f) => f.name));
      // Remplacer les doublons (overwrite) + ajouter les nouveaux
      const existingKept = agent.files.filter((f) => !newFiles.some((nf) => nf.name === f.name));
      const overwritten = newFiles.filter((f) => existingNames.has(f.name));
      const allFiles = [...existingKept, ...newFiles];

      const updated = { ...agent, files: allFiles };
      await updateAgent(updated);
      setAgent(updated);

      const msgs = [];
      const added = newFiles.length - overwritten.length;
      if (added > 0) msgs.push(`${added} fichier${added > 1 ? 's' : ''} ajouté${added > 1 ? 's' : ''}`);
      if (overwritten.length > 0) msgs.push(`${overwritten.length} remplacé${overwritten.length > 1 ? 's' : ''} (${overwritten.map((f) => f.name).join(', ')})`);
      if (msgs.length) setUploadError(`✓ ${msgs.join(' · ')}`);

      showFileSaved();
    } catch {
      setUploadError('Erreur lors de l\'upload. Réessayez.');
      setFilesSaveStatus('idle');
    }

    e.target.value = '';
  };

  const deleteFile = async (fileId: string) => {
    if (!agent) return;
    setFilesSaveStatus('saving');
    const updated = { ...agent, files: agent.files.filter((f) => f.id !== fileId) };
    await updateAgent(updated);
    setAgent(updated);
    showFileSaved();
  };

  if (!agent) {
    return <div className="py-10 text-center text-gray-400">Agent introuvable</div>;
  }

  const tabs: { key: Tab; label: string }[] = [
    { key: 'instructions', label: 'Instructions' },
    { key: 'knowledge', label: 'Base de connaissances' },
  ];

  const hasUnsavedInstructions = instructions !== savedInstructions;

  return (
    <div className="max-w-4xl mx-auto py-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">{agent.name}</h1>
        {!agent.email?.includes('@in.frontapp.com') && (
          <p className="text-gray-400">{agent.email}</p>
        )}
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
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold text-white">Instructions personnalisées</h2>
            <div className="flex items-center gap-3">
              {instructionsSaveStatus === 'saved' && (
                <span className="text-sm text-green-400 font-medium animate-fade-in">
                  Enregistré
                </span>
              )}
              {!isEditingInstructions ? (
                <button
                  onClick={startEditingInstructions}
                  className="rounded-lg bg-gray-700 px-4 py-1.5 text-sm font-medium text-gray-200 hover:bg-gray-600 transition-colors"
                >
                  Modifier
                </button>
              ) : (
                <div className="flex gap-2">
                  <button
                    onClick={cancelEditingInstructions}
                    className="rounded-lg bg-gray-700 px-4 py-1.5 text-sm font-medium text-gray-300 hover:bg-gray-600 transition-colors"
                  >
                    Annuler
                  </button>
                  <button
                    onClick={saveInstructions}
                    disabled={!hasUnsavedInstructions || instructionsSaveStatus === 'saving'}
                    className="rounded-lg bg-green-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-green-700 transition-colors disabled:opacity-50"
                  >
                    {instructionsSaveStatus === 'saving' ? 'Enregistrement...' : 'Sauvegarder'}
                  </button>
                </div>
              )}
            </div>
          </div>
          <p className="text-sm text-gray-400 mb-4">
            Ces instructions seront utilisées comme contexte pour toutes les conversations avec cet agent.
          </p>

          {isEditingInstructions ? (
            <textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              rows={14}
              autoFocus
              placeholder="Entrez les instructions pour cet agent..."
              className="w-full rounded-lg bg-gray-900 border border-blue-500/50 px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 resize-y text-sm leading-relaxed"
            />
          ) : (
            <div className="w-full rounded-lg bg-gray-900/50 border border-gray-700 px-4 py-3 min-h-[120px]">
              {savedInstructions ? (
                <p className="text-sm text-gray-200 whitespace-pre-wrap leading-relaxed">{savedInstructions}</p>
              ) : (
                <p className="text-sm text-gray-500 italic">Aucune instruction définie. Cliquez sur &quot;Modifier&quot; pour en ajouter.</p>
              )}
            </div>
          )}

          {hasUnsavedInstructions && isEditingInstructions && (
            <div className="mt-2 text-xs text-yellow-400">
              Modifications non enregistrées
            </div>
          )}
        </div>
      )}

      {/* Knowledge Base Tab */}
      {activeTab === 'knowledge' && (
        <div className="space-y-6">
          {/* Agent's own files */}
          <div className="rounded-xl bg-gray-800 p-6 border border-gray-700">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <h2 className="text-lg font-semibold text-white">Fichiers de l&apos;agent</h2>
                {filesSaveStatus === 'saved' && (
                  <span className="text-sm text-green-400 font-medium">
                    Enregistré
                  </span>
                )}
                {filesSaveStatus === 'saving' && (
                  <span className="text-sm text-blue-400 font-medium">
                    Enregistrement...
                  </span>
                )}
              </div>
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
              <div className={`mb-4 rounded-lg px-4 py-3 text-sm border ${
                uploadError.startsWith('✓')
                  ? 'bg-green-900/20 border-green-700/40 text-green-400'
                  : 'bg-red-900/20 border-red-700/40 text-red-400'
              }`}>
                {uploadError}
              </div>
            )}

            {showFileForm && (
              <div className="mb-4 flex flex-col gap-3 bg-gray-900 rounded-lg p-4 border border-gray-700">
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
                  Ajouter et enregistrer
                </button>
              </div>
            )}

            {agent.files.length === 0 ? (
              <p className="text-sm text-gray-500">Aucun fichier. Uploadez ou ajoutez manuellement des fichiers.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {agent.files.map((file) => (
                  <div key={file.id} className="bg-gray-900 rounded-lg border border-gray-700/50 overflow-hidden">
                    <div className="flex items-center justify-between px-4 py-3">
                      <div className="flex items-center gap-3 flex-1 min-w-0">
                        <div className="w-8 h-8 rounded-lg bg-blue-600/20 flex items-center justify-center text-blue-400 text-xs font-bold flex-shrink-0">
                          {file.name.split('.').pop()?.toUpperCase().slice(0, 3) || 'TXT'}
                        </div>
                        <div className="min-w-0">
                          <span className="text-sm font-medium text-white">{file.name}</span>
                          <span className="ml-2 text-xs text-gray-500">{file.content.length} car.</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-3 flex-shrink-0">
                        <button
                          onClick={() => setExpandedFileId(expandedFileId === file.id ? null : file.id)}
                          className="text-xs text-blue-400 hover:text-blue-300 px-2 py-1 rounded hover:bg-blue-600/10 transition-colors border border-blue-500/30"
                        >
                          {expandedFileId === file.id ? 'Masquer' : 'Voir le contenu'}
                        </button>
                        <button
                          onClick={() => deleteFile(file.id)}
                          className="text-xs text-red-400 hover:text-red-300 px-2 py-1 rounded hover:bg-red-600/10 transition-colors"
                        >
                          Supprimer
                        </button>
                      </div>
                    </div>
                    {expandedFileId === file.id && (
                      <div className="border-t border-gray-700/50 px-4 py-3">
                        <pre className="text-xs text-gray-300 whitespace-pre-wrap leading-relaxed max-h-64 overflow-y-auto font-mono">
                          {file.content}
                        </pre>
                      </div>
                    )}
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
                  <div key={file.id} className="flex items-center bg-gray-900 rounded-lg px-4 py-3 border border-gray-700/50">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-lg bg-green-600/20 flex items-center justify-center text-green-400 text-xs font-bold">
                        {file.name.split('.').pop()?.toUpperCase().slice(0, 3) || 'TXT'}
                      </div>
                      <div>
                        <span className="text-sm font-medium text-green-400">{file.name}</span>
                        <span className="ml-2 text-xs text-gray-500">{file.content.length} car.</span>
                      </div>
                    </div>
                    <span className="ml-auto text-xs text-gray-500 bg-gray-800 px-2 py-1 rounded">partagé</span>
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
