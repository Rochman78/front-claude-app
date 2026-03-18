'use client';

import { useState, useEffect, useRef } from 'react';
import { useParams } from 'next/navigation';
import { Agent, AgentFile, SharedFile, ChatMessage } from '@/types';
import { getAgent, updateAgent, getSharedFilesForAgent, getChatMessages, saveChatMessages } from '@/lib/storage';

type Tab = 'instructions' | 'knowledge' | 'chat';

export default function AgentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [agent, setAgent] = useState<Agent | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>('instructions');
  const [instructions, setInstructions] = useState('');
  const [sharedFiles, setSharedFiles] = useState<SharedFile[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [newFileName, setNewFileName] = useState('');
  const [newFileContent, setNewFileContent] = useState('');
  const [showFileForm, setShowFileForm] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const a = getAgent(id);
    if (a) {
      setAgent(a);
      setInstructions(a.instructions);
      setSharedFiles(getSharedFilesForAgent(id));
      setChatMessages(getChatMessages(`agent_${id}`));
    }
  }, [id]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  const saveInstructions = () => {
    if (!agent) return;
    const updated = { ...agent, instructions };
    updateAgent(updated);
    setAgent(updated);
  };

  const addFile = () => {
    if (!agent || !newFileName.trim() || !newFileContent.trim()) return;
    const file: AgentFile = {
      id: crypto.randomUUID(),
      name: newFileName.trim(),
      content: newFileContent.trim(),
      createdAt: new Date().toISOString(),
    };
    const updated = { ...agent, files: [...agent.files, file] };
    updateAgent(updated);
    setAgent(updated);
    setNewFileName('');
    setNewFileContent('');
    setShowFileForm(false);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0 || !agent) return;
    let currentAgent = { ...agent };
    let processed = 0;
    Array.from(files).forEach((file) => {
      const reader = new FileReader();
      reader.onload = (ev) => {
        const content = ev.target?.result as string;
        const agentFile: AgentFile = {
          id: crypto.randomUUID(),
          name: file.name,
          content,
          createdAt: new Date().toISOString(),
        };
        currentAgent = { ...currentAgent, files: [...currentAgent.files, agentFile] };
        processed++;
        if (processed === files.length) {
          updateAgent(currentAgent);
          setAgent(currentAgent);
        }
      };
      reader.readAsText(file);
    });
    e.target.value = '';
  };

  const deleteFile = (fileId: string) => {
    if (!agent) return;
    const updated = { ...agent, files: agent.files.filter((f) => f.id !== fileId) };
    updateAgent(updated);
    setAgent(updated);
  };

  const sendMessage = async () => {
    if (!chatInput.trim() || !agent || isLoading) return;

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: chatInput.trim(),
      timestamp: new Date().toISOString(),
    };

    const updatedWithUser = [...chatMessages, userMsg];
    setChatMessages(updatedWithUser);
    setChatInput('');
    setIsLoading(true);

    // Build system prompt with context
    const allFiles = [
      ...agent.files.map((f) => `[Fichier: ${f.name}]\n${f.content}`),
      ...sharedFiles.map((f) => `[Fichier partagé: ${f.name}]\n${f.content}`),
    ].join('\n\n');

    const systemPrompt = `Tu es l'agent "${agent.name}" (${agent.email}).\n\n${agent.instructions || ''}\n\nBase de connaissances:\n${allFiles || '(aucun fichier)'}`;

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemPrompt,
          messages: updatedWithUser.map((m) => ({ role: m.role, content: m.content })),
        }),
      });

      const data = await res.json();

      const assistantMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: data.error ? `Erreur: ${data.error}` : data.content,
        timestamp: new Date().toISOString(),
      };

      const updated = [...updatedWithUser, assistantMsg];
      setChatMessages(updated);
      saveChatMessages(`agent_${id}`, updated);
    } catch {
      const errorMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: 'Erreur de connexion à l\'API. Vérifiez que ANTHROPIC_API_KEY est configurée.',
        timestamp: new Date().toISOString(),
      };
      const updated = [...updatedWithUser, errorMsg];
      setChatMessages(updated);
      saveChatMessages(`agent_${id}`, updated);
    } finally {
      setIsLoading(false);
    }
  };

  if (!agent) {
    return <div className="py-10 text-center text-gray-500">Agent introuvable</div>;
  }

  const tabs: { key: Tab; label: string }[] = [
    { key: 'instructions', label: 'Instructions' },
    { key: 'knowledge', label: 'Base de connaissances' },
    { key: 'chat', label: 'Chat' },
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
                  onClick={() => setShowFileForm(!showFileForm)}
                  className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700 transition-colors"
                >
                  {showFileForm ? 'Annuler' : '+ Manuel'}
                </button>
              </div>
            </div>

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

      {/* Chat Tab */}
      {activeTab === 'chat' && (
        <div className="rounded-xl bg-gray-800 border border-gray-700 flex flex-col h-[500px]">
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {chatMessages.length === 0 && (
              <div className="text-center text-gray-500 py-10">
                Commencez une conversation avec l&apos;agent &quot;{agent.name}&quot;
              </div>
            )}
            {chatMessages.map((msg) => (
              <div
                key={msg.id}
                className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[80%] rounded-xl px-4 py-3 text-sm whitespace-pre-wrap ${
                    msg.role === 'user'
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-700 text-gray-200'
                  }`}
                >
                  {msg.content}
                </div>
              </div>
            ))}
            <div ref={chatEndRef} />
          </div>
          <div className="border-t border-gray-700 p-4 flex gap-3">
            <input
              type="text"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && sendMessage()}
              placeholder="Écrivez un message..."
              className="flex-1 rounded-lg bg-gray-900 border border-gray-600 px-4 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
            />
            <button
              onClick={sendMessage}
              disabled={isLoading}
              className="rounded-lg bg-blue-600 px-6 py-2 text-sm font-semibold text-white hover:bg-blue-700 transition-colors disabled:opacity-50"
            >
              {isLoading ? '...' : 'Envoyer'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
