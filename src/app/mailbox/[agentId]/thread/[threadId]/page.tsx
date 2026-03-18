'use client';

import { useState, useEffect, useRef } from 'react';
import { useParams } from 'next/navigation';
import { Agent, EmailThread, ChatMessage } from '@/types';
import { getAgent, getSharedFilesForAgent, getChatMessages, saveChatMessages } from '@/lib/storage';
import { mockThreads } from '@/lib/mock-emails';

type View = 'thread' | 'chat' | 'draft';

export default function ThreadDetailPage() {
  const { agentId, threadId } = useParams<{ agentId: string; threadId: string }>();
  const [agent, setAgent] = useState<Agent | null>(null);
  const [thread, setThread] = useState<EmailThread | null>(null);
  const [view, setView] = useState<View>('thread');
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [draft, setDraft] = useState('');
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const a = getAgent(agentId);
    if (a) setAgent(a);
    const t = mockThreads.find((t) => t.id === threadId);
    if (t) setThread(t);
  }, [agentId, threadId]);

  useEffect(() => {
    if (view === 'chat') {
      setChatMessages(getChatMessages(`thread_${agentId}_${threadId}`));
    }
  }, [view, agentId, threadId]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  const buildThreadContext = () => {
    if (!thread || !agent) return '';
    const msgs = thread.messages
      .map((m) => `De: ${m.from}\nÀ: ${m.to}\nDate: ${new Date(m.date).toLocaleString('fr-FR')}\n\n${m.body}`)
      .join('\n\n---\n\n');

    const sharedFiles = getSharedFilesForAgent(agentId);
    const allFiles = [
      ...agent.files.map((f) => `[${f.name}]\n${f.content}`),
      ...sharedFiles.map((f) => `[Partagé: ${f.name}]\n${f.content}`),
    ].join('\n\n');

    return `INSTRUCTIONS AGENT "${agent.name}":\n${agent.instructions || '(aucune)'}\n\nBASE DE CONNAISSANCES:\n${allFiles || '(vide)'}\n\nCONVERSATION EMAIL COMPLÈTE:\nSujet: ${thread.subject}\n\n${msgs}`;
  };

  const sendMessage = () => {
    if (!chatInput.trim() || !agent || !thread) return;

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: chatInput.trim(),
      timestamp: new Date().toISOString(),
    };

    const context = buildThreadContext();

    const assistantMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: `[Mode simulation] J'ai analysé la conversation email "${thread.subject}" (${thread.messages.length} messages).\n\nContexte chargé: ${context.length} caractères (instructions + fichiers + emails)\n\nEn réponse à: "${chatInput.trim()}"\n\n> Connectez une API LLM pour obtenir des réponses intelligentes basées sur le contexte complet.`,
      timestamp: new Date().toISOString(),
    };

    const updated = [...chatMessages, userMsg, assistantMsg];
    setChatMessages(updated);
    saveChatMessages(`thread_${agentId}_${threadId}`, updated);
    setChatInput('');
  };

  const handlePushToFront = () => {
    if (!draft.trim()) {
      alert('Le brouillon est vide.');
      return;
    }
    alert(`[FrontApp API] Brouillon envoyé !\n\nContenu:\n${draft.substring(0, 200)}${draft.length > 200 ? '...' : ''}\n\n(Intégration FrontApp API à venir)`);
  };

  if (!agent || !thread) {
    return <div className="py-10 text-center text-gray-500">Thread introuvable</div>;
  }

  return (
    <div className="max-w-4xl mx-auto py-6">
      <div className="mb-4">
        <h1 className="text-xl font-bold text-white">{thread.subject}</h1>
        <p className="text-sm text-gray-400">{thread.participants.join(', ')}</p>
      </div>

      {/* View tabs */}
      <div className="flex gap-2 mb-6">
        <button
          onClick={() => setView('thread')}
          className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
            view === 'thread' ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
          }`}
        >
          Thread
        </button>
        <button
          onClick={() => setView('chat')}
          className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
            view === 'chat' ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
          }`}
        >
          Discuter avec l&apos;assistant
        </button>
        <button
          onClick={() => setView('draft')}
          className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
            view === 'draft' ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
          }`}
        >
          Préparer un brouillon
        </button>
      </div>

      {/* Thread View */}
      {view === 'thread' && (
        <div className="space-y-4">
          {thread.messages.map((msg) => (
            <div key={msg.id} className="rounded-xl bg-gray-800 p-5 border border-gray-700">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <div className="font-semibold text-white">{msg.from}</div>
                  <div className="text-xs text-gray-500">À : {msg.to}</div>
                </div>
                <div className="text-xs text-gray-500">
                  {new Date(msg.date).toLocaleString('fr-FR')}
                </div>
              </div>
              <div className="text-sm text-gray-300 whitespace-pre-wrap leading-relaxed">
                {msg.body}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Chat View */}
      {view === 'chat' && (
        <div className="rounded-xl bg-gray-800 border border-gray-700 flex flex-col h-[500px]">
          <div className="px-4 py-2 border-b border-gray-700 text-xs text-gray-500">
            L&apos;assistant a reçu la conversation email complète + instructions + base de connaissances
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {chatMessages.length === 0 && (
              <div className="text-center text-gray-500 py-10">
                Posez une question sur cette conversation email
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
              placeholder="Posez une question sur cet email..."
              className="flex-1 rounded-lg bg-gray-900 border border-gray-600 px-4 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
            />
            <button
              onClick={sendMessage}
              className="rounded-lg bg-blue-600 px-6 py-2 text-sm font-semibold text-white hover:bg-blue-700 transition-colors"
            >
              Envoyer
            </button>
          </div>
        </div>
      )}

      {/* Draft View */}
      {view === 'draft' && (
        <div className="rounded-xl bg-gray-800 p-6 border border-gray-700">
          <h2 className="text-lg font-semibold text-white mb-4">Éditeur de brouillon</h2>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={10}
            placeholder="Rédigez votre réponse ici..."
            className="w-full rounded-lg bg-gray-900 border border-gray-600 px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 resize-y"
          />
          <div className="mt-4 flex gap-3 justify-end">
            <button
              onClick={() => setView('chat')}
              className="rounded-lg bg-gray-700 px-4 py-2 text-sm font-semibold text-gray-300 hover:bg-gray-600 transition-colors"
            >
              Retour au chat
            </button>
            <button
              onClick={handlePushToFront}
              className="rounded-lg bg-orange-600 px-6 py-2 text-sm font-bold text-white hover:bg-orange-700 transition-colors"
            >
              Pousser vers FrontApp
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
