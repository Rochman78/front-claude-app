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
  const [isLoading, setIsLoading] = useState(false);
  const [isSending, setIsSending] = useState(false);
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

  const buildSystemPrompt = () => {
    if (!thread || !agent) return '';
    const msgs = thread.messages
      .map((m) => `De: ${m.from}\nÀ: ${m.to}\nDate: ${new Date(m.date).toLocaleString('fr-FR')}\n\n${m.body}`)
      .join('\n\n---\n\n');

    const sharedFiles = getSharedFilesForAgent(agentId);
    const allFiles = [
      ...agent.files.map((f) => `[${f.name}]\n${f.content}`),
      ...sharedFiles.map((f) => `[Partagé: ${f.name}]\n${f.content}`),
    ].join('\n\n');

    return `Tu es l'agent "${agent.name}" (${agent.email}).

${agent.instructions || ''}

BASE DE CONNAISSANCES:
${allFiles || '(vide)'}

CONVERSATION EMAIL COMPLÈTE À ANALYSER:
Sujet: ${thread.subject}

${msgs}

Tu dois analyser cette conversation email et répondre aux questions de l'utilisateur en te basant sur tes instructions et ta base de connaissances.`;
  };

  const sendMessage = async () => {
    if (!chatInput.trim() || !agent || !thread || isLoading) return;

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

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemPrompt: buildSystemPrompt(),
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
      saveChatMessages(`thread_${agentId}_${threadId}`, updated);
    } catch {
      const errorMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: "Erreur de connexion à l'API. Vérifiez que ANTHROPIC_API_KEY est configurée.",
        timestamp: new Date().toISOString(),
      };
      const updated = [...updatedWithUser, errorMsg];
      setChatMessages(updated);
      saveChatMessages(`thread_${agentId}_${threadId}`, updated);
    } finally {
      setIsLoading(false);
    }
  };

  const handlePushToFront = async () => {
    if (!draft.trim()) {
      alert('Le brouillon est vide.');
      return;
    }

    setIsSending(true);
    try {
      const res = await fetch('/api/frontapp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: threadId,
          body: draft,
        }),
      });

      const data = await res.json();

      if (data.error) {
        alert(`Erreur FrontApp: ${data.error}`);
      } else {
        alert('Brouillon envoyé vers FrontApp avec succès !');
        setDraft('');
      }
    } catch {
      alert("Erreur de connexion à l'API FrontApp.");
    } finally {
      setIsSending(false);
    }
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
            {isLoading && (
              <div className="flex justify-start">
                <div className="bg-gray-700 text-gray-400 rounded-xl px-4 py-3 text-sm">
                  En train de réfléchir...
                </div>
              </div>
            )}
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
              disabled={isLoading}
              className="rounded-lg bg-blue-600 px-6 py-2 text-sm font-semibold text-white hover:bg-blue-700 transition-colors disabled:opacity-50"
            >
              {isLoading ? '...' : 'Envoyer'}
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
              disabled={isSending}
              className="rounded-lg bg-orange-600 px-6 py-2 text-sm font-bold text-white hover:bg-orange-700 transition-colors disabled:opacity-50"
            >
              {isSending ? 'Envoi...' : 'Pousser vers FrontApp'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
