'use client';

import { useState, useEffect, useRef } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Agent, ChatMessage } from '@/types';
import { getAgent, getSharedFilesForAgent, getChatMessages, saveChatMessages } from '@/lib/storage';

interface FrontMessage {
  id: string;
  author?: { email?: string; name?: string; first_name?: string; last_name?: string };
  recipients?: { handle: string; name?: string; role: string }[];
  subject?: string;
  body: string;
  created_at: number;
  is_inbound: boolean;
  is_draft?: boolean;
}

interface QuoteInfo {
  pdfUrl: string;
  quoteNumber: string;
  amount: string;
}

type QuoteModalState = 'hidden' | 'loading' | 'success' | 'error';
type View = 'thread' | 'draft';

export default function ThreadDetailPage() {
  const { agentId, threadId } = useParams<{ agentId: string; threadId: string }>();
  const [agent, setAgent] = useState<Agent | null>(null);
  const [inboxName, setInboxName] = useState('');
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
  const [hasDraft, setHasDraft] = useState(false);

  // Quote
  const [quoteReady, setQuoteReady] = useState(false);
  const [currentQuote, setCurrentQuote] = useState<QuoteInfo | null>(null);
  const [isGeneratingQuote, setIsGeneratingQuote] = useState(false);
  const [quoteModalState, setQuoteModalState] = useState<QuoteModalState>('hidden');
  const [quoteError, setQuoteError] = useState('');

  // Success modal
  const [successUrl, setSuccessUrl] = useState('');

  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const load = async () => {
      const a = await getAgent(agentId);
      if (a) {
        setAgent(a);
        // Fetch inbox name
        if (a.inboxId) {
          fetch('/api/frontapp/inboxes')
            .then((r) => r.json())
            .then((inboxes: { id: string; name: string }[]) => {
              const found = inboxes.find((i) => i.id === a.inboxId);
              if (found) setInboxName(found.name);
            })
            .catch(() => {});
        }
      }

      try {
        const res = await fetch(`/api/frontapp/messages?conversation_id=${threadId}`);
        const data = await res.json();
        if (data.error) {
          setThreadError(data.error);
        } else {
          const msgs: FrontMessage[] = (data._results || [])
            .filter((m: FrontMessage) => !m.is_draft)
            .sort((a: FrontMessage, b: FrontMessage) => a.created_at - b.created_at);
          setMessages(msgs);
          if (data._subject) setSubject(data._subject);
          else if (msgs.length > 0 && msgs[0].subject) setSubject(msgs[0].subject);
          if (data._partial) setIsPartial(true);
        }
      } catch {
        setThreadError('Erreur de chargement des messages');
      } finally {
        setLoadingThread(false);
      }

      // Check quote readiness + draft
      fetch(`/api/frontapp/summary?conversation_id=${threadId}`)
        .then((r) => r.json())
        .then((d) => setQuoteReady(d.quote_ready || false))
        .catch(() => {});
      fetch(`/api/frontapp/drafts?conversation_id=${threadId}`)
        .then((r) => r.json())
        .then((d) => setHasDraft(d.has_draft || false))
        .catch(() => {});
    };
    load();
  }, [agentId, threadId]);

  useEffect(() => {
    if (view === 'draft') {
      getChatMessages(`thread_${agentId}_${threadId}`).then((msgs) => {
        setChatMessages(msgs);
        if (!draft.trim() && msgs.length > 0) {
          const last = [...msgs].reverse().find((m) => m.role === 'assistant');
          if (last && !last.content.startsWith('Erreur')) setDraft(last.content);
        }
      });
    }
  }, [view, agentId, threadId, draft]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  const stripHtml = (html: string) => {
    const div = document.createElement('div');
    div.innerHTML = html;
    return div.textContent || div.innerText || '';
  };

  const buildEmailContext = () =>
    messages.map((m) => {
      const from = m.author?.email || m.author?.name || 'inconnu';
      const to = m.recipients?.map((r) => r.handle).join(', ') || 'inconnu';
      const date = new Date(m.created_at * 1000).toLocaleString('fr-FR');
      return `De: ${from}\nÀ: ${to}\nDate: ${date}\n\n${stripHtml(m.body)}`;
    }).join('\n\n---\n\n');

  const buildSystemPrompt = async (forDraft = false) => {
    const freshAgent = await getAgent(agentId);
    if (!freshAgent) return '';
    const sharedFiles = await getSharedFilesForAgent(agentId);
    const allFiles = [
      ...freshAgent.files.map((f) => `[${f.name}]\n${f.content}`),
      ...sharedFiles.map((f) => `[Partagé: ${f.name}]\n${f.content}`),
    ].join('\n\n');

    const base = `Tu es l'agent "${freshAgent.name}" (${freshAgent.email}).

${freshAgent.instructions || ''}

BASE DE CONNAISSANCES:
${allFiles || '(vide)'}

CONVERSATION EMAIL:
Sujet: ${subject || '(Sans sujet)'}

${buildEmailContext()}`;

    if (forDraft) {
      return `${base}

Tu dois rédiger une réponse email professionnelle. Rédige UNIQUEMENT le corps de l'email, sans objet ni formule De:/À:.`;
    }
    return `${base}${draft.trim() ? `\n\nBROUILLON ACTUEL:\n${draft}` : ''}

Tu es un assistant qui aide à rédiger des réponses email. Si on te demande de modifier le brouillon, renvoie la version complète modifiée.`;
  };

  const generateDraft = async () => {
    if (!agent || messages.length === 0 || isGeneratingDraft) return;
    setIsGeneratingDraft(true);
    try {
      const systemPrompt = await buildSystemPrompt(true);
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ systemPrompt, messages: [{ role: 'user', content: 'Rédige le brouillon.' }] }),
      });
      const data = await res.json();
      if (!data.error) setDraft(data.content);
    } catch { /* ignore */ } finally {
      setIsGeneratingDraft(false);
    }
  };

  const sendMessage = async () => {
    if (!chatInput.trim() || !agent || isLoading) return;
    const userMsg: ChatMessage = { id: crypto.randomUUID(), role: 'user', content: chatInput.trim(), timestamp: new Date().toISOString() };
    const updated = [...chatMessages, userMsg];
    setChatMessages(updated);
    setChatInput('');
    setIsLoading(true);
    try {
      const systemPrompt = await buildSystemPrompt(false);
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ systemPrompt, messages: updated.map((m) => ({ role: m.role, content: m.content })) }),
      });
      const data = await res.json();
      const content = data.error ? `Erreur: ${data.error}` : data.content;
      if (!data.error && content.trim()) setDraft(content);
      const assistantMsg: ChatMessage = { id: crypto.randomUUID(), role: 'assistant', content, timestamp: new Date().toISOString() };
      const final = [...updated, assistantMsg];
      setChatMessages(final);
      await saveChatMessages(`thread_${agentId}_${threadId}`, final);
    } catch {
      const errMsg: ChatMessage = { id: crypto.randomUUID(), role: 'assistant', content: "Erreur de connexion.", timestamp: new Date().toISOString() };
      const final = [...updated, errMsg];
      setChatMessages(final);
      await saveChatMessages(`thread_${agentId}_${threadId}`, final);
    } finally {
      setIsLoading(false);
    }
  };

  const generateQuote = async () => {
    if (isGeneratingQuote) return;
    setIsGeneratingQuote(true);
    setQuoteModalState('loading');
    setQuoteError('');

    try {
      // Check quote readiness
      const checkRes = await fetch(`/api/frontapp/summary?conversation_id=${threadId}`);
      const checkData = await checkRes.json();
      if (!checkData.quote_ready) {
        setQuoteError(checkData.quote_ready_reason || 'Informations insuffisantes dans la conversation.');
        setQuoteModalState('error');
        return;
      }

      // Ask Claude to extract quote data
      const systemPrompt = await buildSystemPrompt(false);
      const extractRes = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemPrompt,
          messages: [{
            role: 'user',
            content: `Extrais les informations de cette conversation pour créer un devis Pennylane.

RÈGLES :
- Filets sur mesure : type="product", unitPrice=prix HT au m2, quantity=surface totale m2, description="Quantité : X | Total m2 : Y | Délai : environ 14 jours", label="COULEUR - LxH m - Description"
- Transport : type="transport", label="Transport sur mesure", unitPrice=prix HT, quantity=1
- Remise transport : type="transport_discount", unitPrice=prix négatif, quantity=1
- Accessoires/autres : type="free"

Réponds UNIQUEMENT avec un JSON valide (sans markdown) :
{"customer":{"type":"individual","firstName":"","lastName":"","email":"","phone":"","address":{"street":"","zipCode":"","city":"","country":"FR"}},"lines":[{"type":"product","label":"","quantity":0,"unitPrice":0,"vatRate":"FR_200","description":""}],"subject":"","freeText":""}`,
          }],
        }),
      });
      const extractData = await extractRes.json();
      if (extractData.error) throw new Error(extractData.error);

      let quoteData: Record<string, unknown>;
      try {
        const raw = extractData.content.trim().replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim();
        quoteData = JSON.parse(raw);
      } catch {
        throw new Error("Claude n'a pas retourné un JSON valide. Réessayez.");
      }

      quoteData.inboxName = inboxName;

      // Create quote in Pennylane
      const quoteRes = await fetch('/api/pennylane/create-quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(quoteData),
      });
      const quoteResult = await quoteRes.json();

      if (quoteResult.error) {
        setQuoteError(quoteResult.error);
        setQuoteModalState('error');
        return;
      }

      const qi: QuoteInfo = {
        pdfUrl: quoteResult.pdfUrl || '',
        quoteNumber: quoteResult.quoteNumber || '',
        amount: String(quoteResult.amount || '0'),
      };
      setCurrentQuote(qi);
      setQuoteModalState('success');

      // Pre-fill draft
      setDraft(
        `Bonjour,\n\nVeuillez trouver ci-joint votre devis n°${qi.quoteNumber}.\n\nPour confirmer votre commande, merci de nous retourner ce devis signé accompagné du règlement par virement bancaire.\n\nNos coordonnées bancaires figurent sur le devis.\n\nNous restons à votre disposition pour toute question.\n\nCordialement`
      );
    } catch (e) {
      setQuoteError(e instanceof Error ? e.message : 'Erreur inconnue');
      setQuoteModalState('error');
    } finally {
      setIsGeneratingQuote(false);
    }
  };

  const handleSendDraft = async () => {
    if (!draft.trim()) return;
    setIsSending(true);
    try {
      const endpoint = currentQuote ? '/api/frontapp/draft-with-quote' : '/api/frontapp/send';
      const body = currentQuote
        ? { conversation_id: threadId, body: draft, pdf_url: currentQuote.pdfUrl, quote_number: currentQuote.quoteNumber }
        : { conversationId: threadId, body: draft };

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.error) {
        alert(`Erreur: ${data.error}`);
      } else {
        setHasDraft(true);
        setSuccessUrl(data.frontUrl || `https://app.frontapp.com/open/${threadId}`);
        setDraft('');
        setCurrentQuote(null);
      }
    } catch {
      alert("Erreur de connexion.");
    } finally {
      setIsSending(false);
    }
  };

  if (!agent) return <div className="py-10 text-center text-gray-500">Agent introuvable</div>;

  return (
    <div className="max-w-5xl mx-auto py-6 px-4">
      {/* Header */}
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <Link href={`/mailbox/${agentId}`} className="text-xs text-gray-500 hover:text-gray-300 mb-1 inline-block">
            ← {agent.name}
          </Link>
          <h1 className="text-lg font-bold text-white">{subject || '(Sans sujet)'}</h1>
          {hasDraft && (
            <span className="inline-block mt-1 text-xs px-2 py-0.5 rounded-full bg-green-500/20 text-green-400 font-medium">
              brouillon dans Front
            </span>
          )}
          {quoteReady && !currentQuote && (
            <span className="inline-block mt-1 ml-2 text-xs px-2 py-0.5 rounded-full bg-indigo-500/20 text-indigo-400 font-medium">
              devis PDF à faire
            </span>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 mb-5">
        <button
          onClick={() => setView('thread')}
          className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${view === 'thread' ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}
        >
          Conversation
        </button>
        <button
          onClick={() => setView('draft')}
          className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${view === 'draft' ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}
        >
          {hasDraft ? 'Modifier le brouillon' : 'Préparer un brouillon'}
        </button>
      </div>

      {/* Thread View */}
      {view === 'thread' && (
        loadingThread ? (
          <div className="text-center py-12 text-gray-400">Chargement des messages...</div>
        ) : threadError ? (
          <div className="text-center py-12 text-red-400">{threadError}</div>
        ) : (
          <div className="space-y-3">
            {isPartial && (
              <div className="rounded-lg bg-yellow-900/30 border border-yellow-700/50 px-4 py-3 text-sm text-yellow-300">
                Seul le dernier message est affiché. Ajoutez le scope <strong>messages:read</strong> au token FrontApp pour voir l&apos;historique complet.
              </div>
            )}
            {messages.map((msg) => (
              <div key={msg.id} className={`rounded-xl p-5 border ${msg.is_inbound ? 'bg-gray-800 border-gray-700' : 'bg-gray-900 border-gray-800'}`}>
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <span className="font-semibold text-white text-sm">
                      {msg.author?.name || msg.author?.email || 'Inconnu'}
                    </span>
                    <span className="ml-2 text-xs text-gray-500">
                      À : {msg.recipients?.map((r) => r.name || r.handle).join(', ') || 'Inconnu'}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${msg.is_inbound ? 'bg-green-500/20 text-green-300' : 'bg-blue-500/20 text-blue-300'}`}>
                      {msg.is_inbound ? 'Reçu' : 'Envoyé'}
                    </span>
                    <span className="text-xs text-gray-500">
                      {new Date(msg.created_at * 1000).toLocaleString('fr-FR')}
                    </span>
                  </div>
                </div>
                <div className="email-body text-sm leading-relaxed text-gray-200" dangerouslySetInnerHTML={{ __html: msg.body }} />
              </div>
            ))}
            <div className="pt-2 text-center">
              <button
                onClick={() => setView('draft')}
                className="rounded-xl bg-blue-600 px-6 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 transition-colors"
              >
                {hasDraft ? 'Modifier le brouillon avec Claude →' : 'Générer un brouillon avec Claude →'}
              </button>
            </div>
          </div>
        )
      )}

      {/* Draft + Chat View */}
      {view === 'draft' && (
        <div className="flex flex-col gap-4">
          {/* Draft section */}
          <div className="rounded-xl bg-gray-800/80 border border-gray-700 p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-white">Brouillon de réponse</h2>
              <div className="flex gap-2">
                {currentQuote && (
                  <span className="text-xs px-2 py-1 rounded-lg bg-amber-500/20 text-amber-400 border border-amber-500/30">
                    Devis {currentQuote.quoteNumber} — {currentQuote.amount} € HT
                  </span>
                )}
                <button
                  onClick={generateDraft}
                  disabled={isGeneratingDraft || messages.length === 0}
                  className="rounded-lg bg-purple-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-purple-700 transition-colors disabled:opacity-50"
                >
                  {isGeneratingDraft ? 'Génération...' : draft ? 'Régénérer' : "Générer avec l'agent"}
                </button>
              </div>
            </div>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={10}
              placeholder="Cliquez sur « Générer avec l'agent » pour créer un brouillon automatique..."
              className="w-full rounded-lg bg-gray-900 border border-gray-700 px-4 py-3 text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 resize-y text-sm leading-relaxed"
            />
          </div>

          {/* Chat */}
          <div className="rounded-xl bg-gray-800/80 border border-gray-700 flex flex-col" style={{ height: '360px' }}>
            <div className="px-4 py-2.5 border-b border-gray-700 flex items-center justify-between flex-shrink-0">
              <span className="text-sm font-medium text-gray-300">Itérer avec l&apos;agent</span>
              <button
                onClick={generateQuote}
                disabled={isGeneratingQuote}
                title={quoteReady ? 'Générer le devis PDF via Pennylane' : 'Informations insuffisantes pour le devis'}
                className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                  quoteReady
                    ? 'bg-amber-500 hover:bg-amber-600 text-white cursor-pointer'
                    : 'bg-gray-700 text-gray-500 cursor-not-allowed opacity-50'
                }`}
              >
                {isGeneratingQuote ? 'Génération...' : 'Devis PDF'}
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {chatMessages.length === 0 && !isLoading && (
                <div className="text-center text-gray-600 py-6 text-sm">
                  Discutez avec l&apos;agent pour affiner le brouillon.
                </div>
              )}
              {chatMessages.map((msg) => (
                <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap ${
                    msg.role === 'user' ? 'bg-blue-600 text-white' : 'bg-gray-700/80 text-gray-100'
                  }`}>
                    {msg.content}
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
            <div className="border-t border-gray-700 p-3 flex gap-2 flex-shrink-0">
              <input
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && sendMessage()}
                placeholder="Demandez une modification..."
                className="flex-1 rounded-xl bg-gray-900 border border-gray-700 px-4 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500"
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

          {/* Send button */}
          <div className="flex items-center justify-between gap-4 pt-1">
            <p className="text-xs text-gray-600 italic">Ce bouton crée uniquement un brouillon dans Front. Rien n&apos;est envoyé au client.</p>
            <button
              onClick={handleSendDraft}
              disabled={isSending || !draft.trim()}
              className={`flex-shrink-0 rounded-xl px-8 py-3 text-sm font-bold text-white transition-colors uppercase tracking-wide ${
                !draft.trim() ? 'bg-gray-700 opacity-50 cursor-not-allowed'
                : isSending ? 'bg-yellow-600'
                : currentQuote ? 'bg-amber-500 hover:bg-amber-600'
                : 'bg-green-600 hover:bg-green-700'
              }`}
            >
              {isSending ? 'Envoi...' : currentQuote ? 'Charger brouillon + devis dans Front' : 'Charger le brouillon dans Front'}
            </button>
          </div>
        </div>
      )}

      {/* Quote Modal */}
      {quoteModalState !== 'hidden' && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 backdrop-blur-sm">
          <div className="bg-gray-800 rounded-2xl border border-gray-600 p-8 max-w-md w-full mx-4 text-center">
            {quoteModalState === 'loading' && (
              <>
                <div className="flex justify-center mb-4">
                  <svg className="animate-spin h-10 w-10 text-amber-400" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                </div>
                <p className="text-gray-300">Génération du devis en cours...</p>
              </>
            )}
            {quoteModalState === 'success' && currentQuote && (
              <>
                <div className="w-14 h-14 rounded-full bg-green-500 flex items-center justify-center mx-auto mb-4 text-2xl text-white">✓</div>
                <h2 className="text-xl font-bold text-white mb-2">Devis créé avec succès</h2>
                <p className="text-gray-400 mb-6">
                  Devis {currentQuote.quoteNumber} — {currentQuote.amount} € HT
                </p>
                <div className="flex flex-col gap-3">
                  {currentQuote.pdfUrl && (
                    <a
                      href={currentQuote.pdfUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="rounded-xl bg-gray-700 px-6 py-3 text-sm font-medium text-gray-200 hover:bg-gray-600 transition-colors"
                    >
                      Voir le PDF
                    </a>
                  )}
                  <button
                    onClick={() => { setQuoteModalState('hidden'); setView('draft'); }}
                    className="rounded-xl bg-amber-500 px-6 py-3 text-sm font-bold text-white hover:bg-amber-600 transition-colors"
                  >
                    Préparer le brouillon avec le devis →
                  </button>
                </div>
              </>
            )}
            {quoteModalState === 'error' && (
              <>
                <div className="w-14 h-14 rounded-full bg-red-600 flex items-center justify-center mx-auto mb-4 text-2xl text-white">✕</div>
                <h2 className="text-xl font-bold text-white mb-2">Impossible de générer le devis</h2>
                <p className="text-gray-400 mb-6">{quoteError}</p>
                <button
                  onClick={() => setQuoteModalState('hidden')}
                  className="rounded-xl bg-gray-700 px-6 py-3 text-sm font-medium text-gray-200 hover:bg-gray-600 transition-colors"
                >
                  Fermer
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Success modal */}
      {successUrl && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 backdrop-blur-sm">
          <div className="bg-gray-800 rounded-2xl border border-gray-600 p-8 max-w-md w-full mx-4 text-center">
            <div className="w-14 h-14 rounded-full bg-green-500 flex items-center justify-center mx-auto mb-4 text-2xl text-white">✓</div>
            <h2 className="text-xl font-bold text-white mb-2">Brouillon chargé dans Front</h2>
            <p className="text-gray-400 mb-6">Le brouillon a été créé avec succès. Rien n&apos;a été envoyé au client.</p>
            <div className="flex flex-col gap-3">
              <a
                href={successUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-xl bg-blue-600 px-6 py-3 text-sm font-bold text-white hover:bg-blue-700 transition-colors"
              >
                Voir dans FrontApp →
              </a>
              <button
                onClick={() => setSuccessUrl('')}
                className="rounded-xl bg-gray-700 px-6 py-3 text-sm font-medium text-gray-300 hover:bg-gray-600 transition-colors"
              >
                Fermer
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
