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

type View = 'thread' | 'draft';

export default function ThreadDetailPage() {
  const { agentId, threadId } = useParams<{ agentId: string; threadId: string }>();
  const [agent, setAgent] = useState<Agent | null>(null);
  const [subject, setSubject] = useState('');
  const [messages, setMessages] = useState<FrontMessage[]>([]);
  const [isPartial, setIsPartial] = useState(false);
  const [loadingThread, setLoadingThread] = useState(true);
  const [threadError, setThreadError] = useState('');
  const [view, setView] = useState<View>('thread');
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isGeneratingDraft, setIsGeneratingDraft] = useState(false);
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
          if (data._subject) {
            setSubject(data._subject);
          } else if (msgs.length > 0 && msgs[0].subject) {
            setSubject(msgs[0].subject);
          }
          if (data._partial) {
            setIsPartial(true);
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
    if (view === 'draft') {
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

  const buildEmailContext = () => {
    return messages
      .map((m) => {
        const from = m.author?.email || m.author?.name || 'inconnu';
        const to = m.recipients?.map((r) => r.handle).join(', ') || 'inconnu';
        const date = new Date(m.created_at * 1000).toLocaleString('fr-FR');
        return `De: ${from}\nÀ: ${to}\nDate: ${date}\n\n${stripHtml(m.body)}`;
      })
      .join('\n\n---\n\n');
  };

  const buildSystemPrompt = async (forDraft = false) => {
    if (!agent || messages.length === 0) return '';

    const sharedFiles = await getSharedFilesForAgent(agentId);
    const allFiles = [
      ...agent.files.map((f) => `[${f.name}]\n${f.content}`),
      ...sharedFiles.map((f) => `[Partagé: ${f.name}]\n${f.content}`),
    ].join('\n\n');

    const base = `Tu es l'agent "${agent.name}" (${agent.email}).

${agent.instructions || ''}

BASE DE CONNAISSANCES:
${allFiles || '(vide)'}

CONVERSATION EMAIL:
Sujet: ${subject || '(Sans sujet)'}

${buildEmailContext()}`;

    if (forDraft) {
      return `${base}

Tu dois rédiger une réponse email professionnelle à cette conversation en te basant strictement sur tes instructions et ta base de connaissances.
Rédige UNIQUEMENT le corps de l'email de réponse, sans objet, sans formule "De:/À:", juste le texte de la réponse prête à envoyer.`;
    }

    const draftContext = draft.trim()
      ? `\n\nBROUILLON ACTUEL DE RÉPONSE:\n${draft}`
      : '';

    return `${base}${draftContext}

Tu es un assistant qui aide à rédiger et améliorer la réponse à cet email. Tu as accès aux instructions, à la base de connaissances et à la conversation email.
${draft.trim() ? "Un brouillon de réponse a déjà été généré. L'utilisateur peut te demander de le modifier." : ''}
Réponds de manière concise et utile. Si on te demande de modifier le brouillon, renvoie la version complète modifiée.`;
  };

  const generateDraft = async () => {
    if (!agent || messages.length === 0 || isGeneratingDraft) return;
    setIsGeneratingDraft(true);

    try {
      const systemPrompt = await buildSystemPrompt(true);
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemPrompt,
          messages: [{ role: 'user', content: 'Rédige le brouillon de réponse à cet email.' }],
        }),
      });

      const data = await res.json();
      if (data.error) {
        alert(`Erreur: ${data.error}`);
      } else {
        setDraft(data.content);
      }
    } catch {
      alert("Erreur de connexion à l'API.");
    } finally {
      setIsGeneratingDraft(false);
    }
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
      const systemPrompt = await buildSystemPrompt(false);
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
        content: "Erreur de connexion à l'API.",
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
    if (!draft.trim()) return;
    setIsSending(true);
    try {
      const res = await fetch('/api/frontapp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: threadId, body: draft }),
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
    <div className="max-w-5xl mx-auto py-6 px-4">
      <div className="mb-4">
        <h1 className="text-xl font-bold text-white">{subject || '(Sans sujet)'}</h1>
        <p className="text-sm text-gray-400 mt-1">{agent.name}</p>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 mb-6">
        <button
          onClick={() => setView('thread')}
          className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
            view === 'thread' ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
          }`}
        >
          Conversation
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
          <div className="text-center py-12 text-gray-400">Chargement des messages...</div>
        ) : threadError ? (
          <div className="text-center py-12 text-red-400">{threadError}</div>
        ) : messages.length === 0 ? (
          <div className="text-center py-12 text-gray-400">Aucun message dans cette conversation.</div>
        ) : (
          <div className="space-y-4">
            {isPartial && (
              <div className="rounded-lg bg-yellow-900/30 border border-yellow-700/50 px-4 py-3 text-sm text-yellow-300">
                Seul le dernier message est affiché. Ajoutez le scope <strong>messages:read</strong> au token FrontApp pour voir l&apos;historique complet.
              </div>
            )}
            {messages.map((msg) => (
              <div key={msg.id} className="rounded-xl bg-gray-800/80 p-5 border border-gray-700">
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <div className="font-semibold text-white">
                      {msg.author?.name || msg.author?.email || 'Inconnu'}
                    </div>
                    <div className="text-xs text-gray-400">
                      À : {msg.recipients?.map((r) => r.name || r.handle).join(', ') || 'Inconnu'}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                      msg.is_inbound
                        ? 'bg-green-500/20 text-green-300'
                        : 'bg-blue-500/20 text-blue-300'
                    }`}>
                      {msg.is_inbound ? 'Reçu' : 'Envoyé'}
                    </span>
                    <span className="text-xs text-gray-400">
                      {new Date(msg.created_at * 1000).toLocaleString('fr-FR')}
                    </span>
                  </div>
                </div>
                <div
                  className="email-body text-sm leading-relaxed"
                  dangerouslySetInnerHTML={{ __html: msg.body }}
                />
              </div>
            ))}
          </div>
        )
      )}

      {/* Draft + Chat View (Claude Projects style) */}
      {view === 'draft' && (
        <div className="flex flex-col gap-4">
          {/* Draft section */}
          <div className="rounded-xl bg-gray-800/80 border border-gray-700 p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold text-white">Brouillon de réponse</h2>
              <div className="flex gap-2">
                <button
                  onClick={generateDraft}
                  disabled={isGeneratingDraft || messages.length === 0}
                  className="rounded-lg bg-purple-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-purple-700 transition-colors disabled:opacity-50"
                >
                  {isGeneratingDraft ? 'Génération...' : draft.trim() ? 'Régénérer' : 'Générer le brouillon'}
                </button>
                {draft.trim() && (
                  <button
                    onClick={handlePushToFront}
                    disabled={isSending}
                    className="rounded-lg bg-orange-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-orange-700 transition-colors disabled:opacity-50"
                  >
                    {isSending ? 'Envoi...' : 'Envoyer vers FrontApp'}
                  </button>
                )}
              </div>
            </div>
            {isGeneratingDraft && (
              <div className="mb-3 rounded-lg bg-purple-900/20 border border-purple-700/40 px-4 py-3 text-sm text-purple-300">
                L&apos;agent analyse la conversation et rédige une réponse selon ses instructions...
              </div>
            )}
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={10}
              placeholder="Cliquez sur « Générer le brouillon » pour que l'agent prépare une réponse automatique..."
              className="w-full rounded-lg bg-gray-900 border border-gray-600 px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 resize-y text-sm leading-relaxed"
            />
          </div>

          {/* Chat section for iterating */}
          <div className="rounded-xl bg-gray-800/80 border border-gray-700 flex flex-col" style={{ height: '400px' }}>
            <div className="px-4 py-2.5 border-b border-gray-700 flex items-center justify-between">
              <span className="text-sm font-medium text-gray-300">Itérer avec l&apos;agent</span>
              <span className="text-xs text-gray-500">L&apos;agent a accès à la conversation, ses instructions et le brouillon actuel</span>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {chatMessages.length === 0 && !isLoading && (
                <div className="text-center text-gray-500 py-8 text-sm">
                  Discutez avec l&apos;agent pour affiner le brouillon.<br />
                  Ex: &quot;Rends le ton plus formel&quot;, &quot;Ajoute une mention sur les délais&quot;...
                </div>
              )}
              {chatMessages.map((msg) => (
                <div
                  key={msg.id}
                  className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                      msg.role === 'user'
                        ? 'bg-blue-600 text-white'
                        : 'bg-gray-700/80 text-gray-100'
                    }`}
                  >
                    <div className="whitespace-pre-wrap">{msg.content}</div>
                  </div>
                </div>
              ))}
              {isLoading && (
                <div className="flex justify-start">
                  <div className="bg-gray-700/80 text-gray-300 rounded-2xl px-4 py-3 text-sm">
                    <span className="inline-flex gap-1">
                      <span className="animate-pulse">●</span>
                      <span className="animate-pulse" style={{ animationDelay: '0.2s' }}>●</span>
                      <span className="animate-pulse" style={{ animationDelay: '0.4s' }}>●</span>
                    </span>
                  </div>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>
            <div className="border-t border-gray-700 p-3 flex gap-2">
              <input
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && sendMessage()}
                placeholder="Demandez une modification du brouillon..."
                className="flex-1 rounded-xl bg-gray-900 border border-gray-600 px-4 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
              />
              <button
                onClick={sendMessage}
                disabled={isLoading || !chatInput.trim()}
                className="rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-700 transition-colors disabled:opacity-50"
              >
                Envoyer
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
