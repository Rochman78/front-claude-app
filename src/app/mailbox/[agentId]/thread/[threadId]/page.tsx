'use client';

import { useState, useEffect, useRef } from 'react';
import { useParams } from 'next/navigation';
import { Agent, ChatMessage } from '@/types';
import { getAgent, getSharedFilesForAgent, getChatMessages, saveChatMessages } from '@/lib/storage';

interface FrontMessage {
  id: string;
  author?: { email?: string; name?: string };
  recipients?: { handle: string; name?: string; role: string }[];
  subject?: string;
  body: string;
  created_at: number;
  is_inbound: boolean;
}

type View = 'thread' | 'chat' | 'draft';

export default function ThreadDetailPage() {
  const { agentId, threadId } = useParams<{ agentId: string; threadId: string }>();
  const [agent, setAgent] = useState<Agent | null>(null);
  const [subject, setSubject] = useState('');
  const [messages, setMessages] = useState<FrontMessage[]>([]);
  const [loadingThread, setLoadingThread] = useState(true);
  const [threadError, setThreadError] = useState('');
  const [view, setView] = useState<View>('thread');
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [draft, setDraft] = useState('');
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const load = async () => {
      const a = await getAgent(agentId);
      if (a) setAgent(a);

      try {
        const res = await fetch(`/api/frontapp/messages?conversation_id=${threadId}`);
        const data = await res.json();
        if (data.error) {
          setThreadError(data.error);
        } else {
          const msgs: FrontMessage[] = data._results || [];
          setMessages(msgs.sort((a, b) => a.created_at - b.created_at));
          if (msgs.length > 0 && msgs[0].subject) {
            setSubject(msgs[0].subject);
          }
        }
      } catch {
        setThreadError('Erreur de chargement des messages');
      } finally {
        setLoadingThread(false);
      }
    };
    load();
  }, [agentId, threadId]);

  useEffect(() => {
    if (view === 'chat') {
      getChatMessages(`thread_${agentId}_${threadId}`).then(setChatMessages);
    }
  }, [view, agentId, threadId]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  const stripHtml = (html: string) => {
    const div = document.createElement('div');
    div.innerHTML = html;
    return div.textContent || div.innerText || '';
  };

  const buildSystemPrompt = async () => {
    if (!agent || messages.length === 0) return '';
    const msgs = messages
      .map((m) => {
        const from = m.author?.email || 'inconnu';
        const to = m.recipients?.map((r) => r.handle).join(', ') || 'inconnu';
        const date = new Date(m.created_at * 1000).toLocaleString('fr-FR');
        return `De: ${from}\nÀ: ${to}\nDate: ${date}\n\n${stripHtml(m.body)}`;
      })
      .join('\n\n---\n\n');

    const sharedFiles = await getSharedFilesForAgent(agentId);
    const allFiles = [
      ...agent.files.map((f) => `[${f.name}]\n${f.content}`),
      ...sharedFiles.map((f) => `[Partagé: ${f.name}]\n${f.content}`),
    ].join('\n\n');

    return `Tu es l'agent "${agent.name}" (${agent.email}).

${agent.instructions || ''}

BASE DE CONNAISSANCES:
${allFiles || '(vide)'}

CONVERSATION EMAIL COMPLÈTE À ANALYSER:
Sujet: ${subject || '(Sans sujet)'}

${msgs}

Tu dois analyser cette conversation email et répondre aux questions de l'utilisateur en te basant sur tes instructions et ta base de connaissances.`;
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

    try {
      const systemPrompt = await buildSystemPrompt();
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
      await saveChatMessages(`thread_${agentId}_${threadId}`, updated);
    } catch {
      const errorMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: "Erreur de connexion à l'API. Vérifiez que ANTHROPIC_API_KEY est configurée.",
        timestamp: new Date().toISOString(),
      };
      const updated = [...updatedWithUser, errorMsg];
      setChatMessages(updated);
      await saveChatMessages(`thread_${agentId}_${threadId}`, updated);
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

  if (!agent) {
    return <div className="py-10 text-center text-gray-500">Agent introuvable</div>;
  }

  return (
    <div className="max-w-4xl mx-auto py-6">
      <div className="mb-4">
        <h1 className="text-xl font-bold text-white">{subject || '(Sans sujet)'}</h1>
        <p className="text-sm text-gray-400">{agent.name} — {agent.email}</p>
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
        loadingThread ? (
          <div className="text-center py-12 text-gray-500">Chargement des messages...</div>
        ) : threadError ? (
          <div className="text-center py-12 text-red-400">{threadError}</div>
        ) : messages.length === 0 ? (
          <div className="text-center py-12 text-gray-500">Aucun message dans cette conversation.</div>
        ) : (
          <div className="space-y-4">
            {messages.map((msg) => (
              <div key={msg.id} className="rounded-xl bg-gray-800 p-5 border border-gray-700">
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <div className="font-semibold text-white">
                      {msg.author?.name || msg.author?.email || 'Inconnu'}
                    </div>
                    <div className="text-xs text-gray-500">
                      À : {msg.recipients?.map((r) => r.name || r.handle).join(', ') || 'Inconnu'}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${
                      msg.is_inbound
                        ? 'bg-green-600/20 text-green-400'
                        : 'bg-blue-600/20 text-blue-400'
                    }`}>
                      {msg.is_inbound ? 'Reçu' : 'Envoyé'}
                    </span>
                    <span className="text-xs text-gray-500">
                      {new Date(msg.created_at * 1000).toLocaleString('fr-FR')}
                    </span>
                  </div>
                </div>
                <div
                  className="text-sm text-gray-300 leading-relaxed prose prose-invert max-w-none"
                  dangerouslySetInnerHTML={{ __html: msg.body }}
                />
              </div>
            ))}
          </div>
        )
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
