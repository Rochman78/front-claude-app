'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Agent, ChatMessage } from '@/types';
import { getAgent, getSharedFilesForAgent, getChatMessages, saveChatMessages } from '@/lib/storage';

interface FrontMessage {
  id: string;
  author?: { email?: string; name?: string };
  recipients?: { handle: string; name?: string }[];
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

type QuoteModal = 'hidden' | 'loading' | 'success' | 'error';

export default function ThreadDetailPage() {
  const { agentId, threadId } = useParams<{ agentId: string; threadId: string }>();
  const router = useRouter();
  const [agent, setAgent] = useState<Agent | null>(null);
  const [inboxName, setInboxName] = useState('');
  const [subject, setSubject] = useState('');
  const [messages, setMessages] = useState<FrontMessage[]>([]);
  const [isPartial, setIsPartial] = useState(false);
  const [loadingThread, setLoadingThread] = useState(true);
  const [threadError, setThreadError] = useState('');

  const [showReply, setShowReply] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isGeneratingDraft, setIsGeneratingDraft] = useState(false);
  const [draft, setDraft] = useState('');
  const [hasDraft, setHasDraft] = useState(false);

  // Devis
  const [quoteReady, setQuoteReady] = useState(false);
  const [quoteReadyReason, setQuoteReadyReason] = useState('');
  const [currentQuote, setCurrentQuote] = useState<QuoteInfo | null>(null);
  const [isGeneratingQuote, setIsGeneratingQuote] = useState(false);
  const [quoteModal, setQuoteModal] = useState<QuoteModal>('hidden');
  const [quoteError, setQuoteError] = useState('');

  const [successUrl, setSuccessUrl] = useState('');

  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const load = async () => {
      const a = await getAgent(agentId);
      if (a) {
        setAgent(a);
        if (a.inboxId) {
          fetch('/api/frontapp/inboxes').then((r) => r.json())
            .then((list: { id: string; name: string }[]) => {
              const found = list.find((i) => i.id === a.inboxId);
              if (found) setInboxName(found.name);
            }).catch(() => {});
        }
      }

      try {
        const res = await fetch(`/api/frontapp/messages?conversation_id=${threadId}`);
        const data = await res.json();
        if (data.error) { setThreadError(data.error); }
        else {
          const msgs = ((data._results || []) as FrontMessage[])
            .filter((m) => !m.is_draft)
            .sort((a, b) => a.created_at - b.created_at);
          setMessages(msgs);
          if (data._subject) setSubject(data._subject);
          else if (msgs[0]?.subject) setSubject(msgs[0].subject as string);
          if (data._partial) setIsPartial(true);
        }
      } catch { setThreadError('Erreur de chargement'); }
      finally { setLoadingThread(false); }

      fetch(`/api/frontapp/summary?conversation_id=${threadId}`)
        .then((r) => r.json())
        .then((d) => { setQuoteReady(d.quote_ready || false); setQuoteReadyReason(d.quote_ready_reason || ''); })
        .catch(() => {});
      fetch(`/api/frontapp/drafts?conversation_id=${threadId}`)
        .then((r) => r.json()).then((d) => setHasDraft(d.has_draft || false)).catch(() => {});
    };
    load();
  }, [agentId, threadId]);

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [chatMessages]);

  const stripHtml = (html: string) => { const d = document.createElement('div'); d.innerHTML = html; return d.textContent || ''; };

  const buildEmailContext = useCallback(() =>
    messages.map((m) => {
      const from = m.author?.email || m.author?.name || 'inconnu';
      const date = new Date(m.created_at * 1000).toLocaleString('fr-FR');
      return `De: ${from} — ${date}\n${stripHtml(m.body)}`;
    }).join('\n\n---\n\n'),
  [messages]);

  const buildSystemPrompt = useCallback(async (forDraft = false) => {
    const a = await getAgent(agentId);
    if (!a) return '';
    const shared = await getSharedFilesForAgent(agentId);
    const files = [
      ...a.files.map((f) => `[${f.name}]\n${f.content}`),
      ...shared.map((f) => `[Partagé: ${f.name}]\n${f.content}`),
    ].join('\n\n');
    const base = `Tu es l'agent "${a.name}" (${a.email}).\n\n${a.instructions || ''}\n\nBASE DE CONNAISSANCES:\n${files || '(vide)'}\n\nCONVERSATION EMAIL — Sujet: ${subject}\n\n${buildEmailContext()}`;
    if (forDraft) return `${base}\n\nPeu importe tes instructions habituelles de structure : tu dois renvoyer UNIQUEMENT le corps de l'email de réponse prêt à envoyer. Pas d'analyse, pas de section BROUILLON, pas de titre, pas de markdown (pas de **, *, #). Commence directement par la formule de politesse (ex: "Bonjour ...") et termine par la signature.`;
    return `${base}${draft.trim() ? `\n\nBROUILLON ACTUEL:\n${draft}` : ''}\n\nTu aides à rédiger des réponses email. Si on te demande de modifier le brouillon, renvoie la version complète modifiée.`;
  }, [agentId, subject, draft, buildEmailContext]);

  const cleanDraftContent = (raw: string): string => {
    // Si Claude a inclus une section BROUILLON DE RÉPONSE, extraire uniquement cette partie
    const brouillonMatch = raw.match(/\*?\*?BROUILLON\s+DE\s+R[EÉ]PONSE\s*:?\*?\*?\s*\n+([\s\S]+)/i);
    if (brouillonMatch) return brouillonMatch[1].trim();
    // Supprimer section d'analyse en tête si présente
    const analyseMatch = raw.match(/\*?\*?[A-ZÀÉÈÊ\s]+:?\*?\*?[\s\S]*?\n\n([\s\S]+)/);
    if (analyseMatch && /^(bonjour|chère|cher|madame|monsieur|hello)/i.test(analyseMatch[1])) {
      return analyseMatch[1].trim();
    }
    return raw.trim();
  };

  const renderMarkdown = (text: string) => ({
    __html: text
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*\n]+)\*/g, '<em>$1</em>'),
  });

  const generateDraft = useCallback(async () => {
    if (!messages.length || isGeneratingDraft) return;
    setIsGeneratingDraft(true);
    try {
      const sys = await buildSystemPrompt(true);
      const res = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ systemPrompt: sys, messages: [{ role: 'user', content: 'Rédige le brouillon.' }] }) });
      const data = await res.json();
      if (!data.error) {
        const content = cleanDraftContent(data.content);
        setDraft(content);
        const am: ChatMessage = { id: crypto.randomUUID(), role: 'assistant', content, timestamp: new Date().toISOString() };
        setChatMessages((prev) => {
          const updated = [...prev, am];
          saveChatMessages(`thread_${agentId}_${threadId}`, updated);
          return updated;
        });
      }
    } catch { /**/ } finally { setIsGeneratingDraft(false); }
  }, [messages.length, isGeneratingDraft, buildSystemPrompt, agentId, threadId]);

  const handleOpenReply = useCallback(async () => {
    setShowReply(true);
    const msgs = await getChatMessages(`thread_${agentId}_${threadId}`);
    setChatMessages(msgs);
    const lastAI = [...msgs].reverse().find((m) => m.role === 'assistant');
    if (lastAI && !lastAI.content.startsWith('Erreur')) {
      setDraft(lastAI.content);
    } else if (!draft.trim() && messages.length) {
      generateDraft();
    }
  }, [agentId, threadId, draft, messages.length, generateDraft]);

  const sendMessage = async () => {
    if (!chatInput.trim() || !agent || isLoading) return;
    const userMsg: ChatMessage = { id: crypto.randomUUID(), role: 'user', content: chatInput.trim(), timestamp: new Date().toISOString() };
    const updated = [...chatMessages, userMsg];
    setChatMessages(updated); setChatInput(''); setIsLoading(true);
    try {
      const sys = await buildSystemPrompt(false);
      const res = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ systemPrompt: sys, messages: updated.map((m) => ({ role: m.role, content: m.content })) }) });
      const data = await res.json();
      const content = data.error ? `Erreur: ${data.error}` : data.content;
      if (!data.error && content.trim()) setDraft(content);
      const am: ChatMessage = { id: crypto.randomUUID(), role: 'assistant', content, timestamp: new Date().toISOString() };
      const final = [...updated, am];
      setChatMessages(final);
      await saveChatMessages(`thread_${agentId}_${threadId}`, final);
    } catch {
      const am: ChatMessage = { id: crypto.randomUUID(), role: 'assistant', content: 'Erreur de connexion.', timestamp: new Date().toISOString() };
      const final = [...updated, am];
      setChatMessages(final);
      await saveChatMessages(`thread_${agentId}_${threadId}`, final);
    } finally { setIsLoading(false); }
  };

  const generateQuote = async () => {
    if (isGeneratingQuote) return;
    setIsGeneratingQuote(true); setQuoteModal('loading'); setQuoteError('');
    try {
      const check = await fetch(`/api/frontapp/summary?conversation_id=${threadId}`).then((r) => r.json());
      if (!check.quote_ready) { setQuoteError(check.quote_ready_reason || 'Informations insuffisantes.'); setQuoteModal('error'); return; }
      const sys = await buildSystemPrompt(false);
      const extract = await fetch('/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ systemPrompt: sys, messages: [{ role: 'user', content: `Extrais les informations de cette conversation pour créer un devis Pennylane.\n\nRÈGLES :\n- Filets sur mesure : type="product", unitPrice=prix HT/m2, quantity=surface totale m2, description="Quantité : X | Total m2 : Y | Délai : environ 14 jours", label="COULEUR - LxH m - Description"\n- Transport : type="transport", label="Transport sur mesure", unitPrice=prix HT, quantity=1\n- Remise transport : type="transport_discount", unitPrice=prix négatif, quantity=1\n- Accessoires : type="free"\n\nRéponds UNIQUEMENT avec un JSON valide (sans markdown) :\n{"customer":{"type":"individual","firstName":"","lastName":"","email":"","phone":"","address":{"street":"","zipCode":"","city":"","country":"FR"}},"lines":[{"type":"product","label":"","quantity":0,"unitPrice":0,"vatRate":"FR_200","description":""}],"subject":"","freeText":""}` }] }),
      }).then((r) => r.json());
      if (extract.error) throw new Error(extract.error);
      let quoteData: Record<string, unknown>;
      try {
        const raw = extract.content.trim().replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim();
        quoteData = JSON.parse(raw);
      } catch { throw new Error("Claude n'a pas retourné un JSON valide."); }
      quoteData.inboxName = inboxName;
      const result = await fetch('/api/pennylane/create-quote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(quoteData) }).then((r) => r.json());
      if (result.error) { setQuoteError(result.error); setQuoteModal('error'); return; }
      const qi: QuoteInfo = { pdfUrl: result.pdfUrl || '', quoteNumber: result.quoteNumber || '', amount: String(result.amount || '0') };
      setCurrentQuote(qi); setQuoteModal('success');
      setDraft(`Bonjour,\n\nVeuillez trouver ci-joint votre devis n°${qi.quoteNumber}.\n\nPour confirmer votre commande, merci de nous retourner ce devis signé accompagné du règlement par virement bancaire.\n\nNos coordonnées bancaires figurent sur le devis.\n\nNous restons à votre disposition pour toute question.\n\nCordialement`);
    } catch (e) { setQuoteError(e instanceof Error ? e.message : 'Erreur inconnue'); setQuoteModal('error'); }
    finally { setIsGeneratingQuote(false); }
  };

  const handleSendDraft = async () => {
    if (!draft.trim()) return;
    setIsSending(true);
    try {
      const endpoint = currentQuote ? '/api/frontapp/draft-with-quote' : '/api/frontapp/send';
      const payload = currentQuote
        ? { conversation_id: threadId, body: draft, pdf_url: currentQuote.pdfUrl, quote_number: currentQuote.quoteNumber }
        : { conversationId: threadId, body: draft };
      const data = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).then((r) => r.json());
      if (data.error) { alert(`Erreur: ${data.error}`); return; }
      setHasDraft(true);
      setSuccessUrl(data.frontUrl || `https://app.frontapp.com/open/${threadId}`);
      setDraft(''); setCurrentQuote(null);
    } catch { alert('Erreur de connexion.'); }
    finally { setIsSending(false); }
  };

  if (!agent) return <div className="py-10 text-center text-gray-400 text-sm">Agent introuvable</div>;

  return (
    <div className={showReply ? 'max-w-6xl mx-auto' : 'max-w-3xl mx-auto'}>

      {/* Header */}
      <div className="mb-5">
        <Link href={`/mailbox/${agentId}`} className="text-xs text-gray-400 hover:text-gray-600 mb-1 inline-block">
          ← {agent.name}
        </Link>
        <div className="flex items-start justify-between gap-3">
          <h1 className="text-base font-bold text-gray-900">{subject || '(Sans sujet)'}</h1>
          {showReply && (
            <button onClick={() => setShowReply(false)} className="text-xs text-gray-400 hover:text-gray-600 flex-shrink-0 mt-0.5">
              ← Plein écran
            </button>
          )}
        </div>
        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
          {hasDraft && (
            <span className="text-xs px-2 py-0.5 rounded bg-green-100 text-green-700 font-medium">● brouillon dans Front</span>
          )}
          {quoteReady && !currentQuote && (
            <span className="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-700 font-medium">● devis à faire</span>
          )}
          {currentQuote && (
            <span className="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-700 font-medium">● devis {currentQuote.quoteNumber} — {currentQuote.amount} € HT</span>
          )}
        </div>
      </div>

      {/* ── LAYOUT : thread seul ou split ── */}
      {!showReply ? (
        /* ── VUE THREAD SEULE ── */
        <div>
          {loadingThread ? (
            <div className="text-center py-12 text-gray-400 text-sm">Chargement...</div>
          ) : threadError ? (
            <div className="text-center py-12 text-red-500 text-sm">{threadError}</div>
          ) : (
            <div className="space-y-3">
              {isPartial && (
                <div className="rounded-lg bg-yellow-50 border border-yellow-200 px-4 py-3 text-sm text-yellow-700">
                  Seul le dernier message est affiché. Ajoutez le scope <strong>messages:read</strong> au token FrontApp pour voir l&apos;historique complet.
                </div>
              )}
              {messages.map((msg) => (
                <div key={msg.id} className={`rounded-xl border p-5 ${msg.is_inbound ? 'bg-white border-gray-200' : 'bg-gray-50 border-gray-100'}`}>
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <span className={`text-xs px-2 py-0.5 rounded font-medium ${msg.is_inbound ? 'bg-blue-50 text-blue-600' : 'bg-gray-100 text-gray-500'}`}>
                        {msg.is_inbound ? 'Reçu' : 'Envoyé'}
                      </span>
                      <span className="text-sm font-semibold text-gray-800">{msg.author?.name || msg.author?.email || 'Inconnu'}</span>
                    </div>
                    <span className="text-xs text-gray-400">{new Date(msg.created_at * 1000).toLocaleString('fr-FR')}</span>
                  </div>
                  <div className="email-body" dangerouslySetInnerHTML={{ __html: msg.body }} />
                </div>
              ))}

              {/* CTA centré */}
              <div className="flex justify-center pt-6 pb-4">
                <button
                  onClick={handleOpenReply}
                  className="rounded-xl bg-blue-600 px-8 py-3 text-sm font-bold text-white hover:bg-blue-700 transition-colors shadow-sm"
                >
                  {hasDraft ? '✏️ Modifier le brouillon avec Claude' : '✦ Préparer une réponse avec Claude'}
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        /* ── VUE SPLIT : 1/3 conversation | 2/3 chat+brouillon ── */
        <div className="flex gap-4" style={{ height: 'calc(100vh - 180px)', minHeight: '500px' }}>

          {/* Gauche — conversation pleine hauteur */}
          <div className="w-2/5 flex-shrink-0 overflow-y-auto space-y-2 pr-1">
            {loadingThread ? (
              <div className="text-center py-8 text-gray-400 text-xs">Chargement...</div>
            ) : messages.map((msg) => (
              <div key={msg.id} className={`rounded-lg border px-3 py-3 ${msg.is_inbound ? 'bg-white border-gray-200' : 'bg-gray-50 border-gray-100'}`}>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-1.5">
                    <span className={`text-xs px-1.5 py-px rounded font-medium ${msg.is_inbound ? 'bg-blue-50 text-blue-600' : 'bg-gray-100 text-gray-500'}`}>
                      {msg.is_inbound ? 'Reçu' : 'Envoyé'}
                    </span>
                    <span className="text-xs font-semibold text-gray-700 truncate max-w-[120px]">{msg.author?.name || msg.author?.email || 'Inconnu'}</span>
                  </div>
                  <span className="text-xs text-gray-400 flex-shrink-0">{new Date(msg.created_at * 1000).toLocaleDateString('fr-FR')}</span>
                </div>
                <div className="email-body text-xs" dangerouslySetInnerHTML={{ __html: msg.body }} />
              </div>
            ))}
          </div>

          {/* Droite — brouillon (2/3) + chat (1/3) */}
          <div className="flex-1 flex flex-col gap-3 min-w-0 overflow-visible">

            {/* Discussion unifiée — pleine hauteur */}
            <div className="bg-white rounded-xl border border-gray-200 flex flex-col flex-1 min-h-0 overflow-hidden">
              <div className="flex-1 overflow-y-auto p-4 space-y-3">
                {!chatMessages.length && !isLoading && !isGeneratingDraft && (
                  <p className="text-center text-gray-400 text-sm py-8">
                    Génération du brouillon en cours...
                  </p>
                )}
                {chatMessages.map((msg) => (
                  <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[88%] rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap ${
                      msg.role === 'user'
                        ? 'bg-blue-600 text-white'
                        : 'bg-gray-100 text-gray-800'
                    }`}
                      dangerouslySetInnerHTML={msg.role === 'assistant' ? renderMarkdown(msg.content) : undefined}
                    >
                      {msg.role === 'user' ? msg.content : undefined}
                    </div>
                  </div>
                ))}
                {(isLoading || isGeneratingDraft) && (
                  <div className="flex justify-start">
                    <div className="bg-gray-100 rounded-2xl px-4 py-3 text-sm text-gray-400 flex items-center gap-1">
                      <span className="animate-pulse">●</span>
                      <span className="animate-pulse" style={{ animationDelay: '0.15s' }}>●</span>
                      <span className="animate-pulse" style={{ animationDelay: '0.3s' }}>●</span>
                    </div>
                  </div>
                )}
                <div ref={chatEndRef} />
              </div>
              <div className="border-t border-gray-100 p-3 flex gap-2 flex-shrink-0">
                <textarea
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
                  placeholder="Demandez une modification... (Maj+Entrée pour sauter une ligne)"
                  rows={1}
                  className="flex-1 rounded-lg bg-gray-50 border border-gray-200 px-3 py-2 text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:border-blue-400 resize-none overflow-hidden"
                  style={{ maxHeight: '120px', overflowY: chatInput.split('\n').length > 4 ? 'auto' : 'hidden' }}
                />
                <button
                  onClick={sendMessage} disabled={isLoading || isGeneratingDraft || !chatInput.trim()}
                  className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors disabled:opacity-40"
                >
                  Envoyer
                </button>
              </div>
            </div>

            {/* Barre d'actions */}
            <div className="flex items-center justify-between gap-3 py-1 flex-shrink-0">
              {/* 🟡 Devis PDF */}
              <div className="relative group inline-block">
                <button
                  onClick={quoteReady ? generateQuote : undefined}
                  disabled={isGeneratingQuote}
                  className={`rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${
                    quoteReady
                      ? 'bg-amber-500 hover:bg-amber-600 text-white cursor-pointer'
                      : 'bg-gray-100 text-gray-400 cursor-not-allowed'
                  }`}
                >
                  {isGeneratingQuote ? 'Génération devis...' : currentQuote ? '✓ Devis créé' : '⬡ Générer le devis PDF'}
                </button>
                {!quoteReady && (
                  <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-1.5 bg-gray-800 text-white text-xs rounded-lg whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-20 max-w-xs text-center">
                    {quoteReadyReason || 'Le client doit valider une proposition chiffrée avant de générer un devis'}
                  </div>
                )}
              </div>

              <div className="flex items-center gap-3">
                <p className="text-xs text-gray-400 italic">Crée un brouillon dans Front — rien n&apos;est envoyé au client</p>
                {/* 🟢 Charger dans Front */}
                <div className="relative group inline-block">
                  <button
                    onClick={draft.trim() ? handleSendDraft : undefined}
                    disabled={isSending}
                    className={`rounded-lg px-5 py-2 text-sm font-bold text-white transition-colors flex-shrink-0 ${
                      !draft.trim() ? 'bg-gray-300 cursor-not-allowed'
                      : isSending ? 'bg-green-400'
                      : 'bg-green-600 hover:bg-green-700'
                    }`}
                  >
                    {isSending ? 'Envoi...' : currentQuote ? '↑ Charger brouillon + devis dans Front' : '↑ Charger dans Front'}
                  </button>
                  {!draft.trim() && (
                    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-1.5 bg-gray-800 text-white text-xs rounded-lg whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-20">
                      Rédigez ou générez un brouillon d&apos;abord
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── MODALE DEVIS ── */}
      {quoteModal !== 'hidden' && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 backdrop-blur-sm">
          <div className="bg-white rounded-2xl border border-gray-200 shadow-xl p-8 max-w-sm w-full mx-4 text-center">
            {quoteModal === 'loading' && (
              <>
                <div className="flex justify-center mb-4">
                  <svg className="animate-spin h-10 w-10 text-amber-500" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                </div>
                <p className="text-sm text-gray-600">Génération du devis en cours...</p>
              </>
            )}
            {quoteModal === 'success' && currentQuote && (
              <>
                <div className="w-12 h-12 rounded-full bg-amber-100 flex items-center justify-center mx-auto mb-4 text-2xl">⬡</div>
                <h2 className="text-lg font-bold text-gray-900 mb-1">Devis créé</h2>
                <p className="text-sm text-gray-500 mb-6">N°{currentQuote.quoteNumber} — {currentQuote.amount} € HT</p>
                <div className="flex flex-col gap-2">
                  {currentQuote.pdfUrl && (
                    <a href={currentQuote.pdfUrl} target="_blank" rel="noopener noreferrer"
                      className="rounded-lg border border-gray-200 px-5 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors">
                      Voir le PDF →
                    </a>
                  )}
                  <button onClick={() => setQuoteModal('hidden')}
                    className="rounded-lg bg-amber-500 hover:bg-amber-600 px-5 py-2.5 text-sm font-bold text-white transition-colors">
                    Préparer le brouillon avec le devis →
                  </button>
                </div>
              </>
            )}
            {quoteModal === 'error' && (
              <>
                <div className="w-12 h-12 rounded-full bg-red-50 flex items-center justify-center mx-auto mb-4 text-xl text-red-500">✕</div>
                <h2 className="text-lg font-bold text-gray-900 mb-1">Devis impossible</h2>
                <p className="text-sm text-gray-500 mb-6">{quoteError}</p>
                <button onClick={() => setQuoteModal('hidden')}
                  className="rounded-lg border border-gray-200 px-5 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors w-full">
                  Fermer
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── MODALE SUCCÈS FRONT ── */}
      {successUrl && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 backdrop-blur-sm">
          <div className="bg-white rounded-2xl border border-gray-200 shadow-xl p-8 max-w-sm w-full mx-4 text-center">
            <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4 text-xl text-green-600">✓</div>
            <h2 className="text-lg font-bold text-gray-900 mb-1">Brouillon chargé dans Front</h2>
            <p className="text-sm text-gray-500 mb-6">Rien n&apos;a été envoyé au client. Le brouillon attend votre validation dans FrontApp.</p>
            <div className="flex flex-col gap-2">
              <a href={successUrl} target="_blank" rel="noopener noreferrer"
                className="rounded-lg bg-green-600 hover:bg-green-700 px-5 py-2.5 text-sm font-bold text-white transition-colors">
                Voir dans FrontApp →
              </a>
              <button onClick={() => router.push(`/mailbox/${agentId}`)}
                className="rounded-lg border border-gray-200 px-5 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors">
                Fermer
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
