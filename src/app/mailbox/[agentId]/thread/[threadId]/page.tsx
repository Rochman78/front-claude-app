'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Agent, ChatMessage } from '@/types';
import { getAgent, getSharedFilesForAgent, saveChatMessages } from '@/lib/storage';

interface FrontMessage {
  id: string;
  author?: { email?: string; name?: string };
  recipients?: { handle: string; name?: string }[];
  subject?: string;
  body: string;
  created_at: number;
  is_inbound: boolean;
  is_draft?: boolean;
  is_comment?: boolean;
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
  const [sharedFiles, setSharedFiles] = useState<import('@/types').SharedFile[]>([]);
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
  const [, setDraftValidated] = useState(false);
  const [, setDraftReadyToValidate] = useState(false);
  const [hasDraft, setHasDraft] = useState(false);

  // Devis
  const [quoteReady, setQuoteReady] = useState(false);
  const [quoteReadyReason, setQuoteReadyReason] = useState('');
  const [currentQuote, setCurrentQuote] = useState<QuoteInfo | null>(null);
  const [isGeneratingQuote, setIsGeneratingQuote] = useState(false);
  const [quoteModal, setQuoteModal] = useState<QuoteModal>('hidden');
  const [showQuoteWarning, setShowQuoteWarning] = useState(false);
  const [quoteError, setQuoteError] = useState('');

  const [successUrl, setSuccessUrl] = useState('');
  const [showLeaveModal, setShowLeaveModal] = useState(false);
  const [pendingNav, setPendingNav] = useState('');

  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const load = async () => {
      const [a, shared] = await Promise.all([
        getAgent(agentId),
        getSharedFilesForAgent(agentId),
      ]);
      if (a) {
        setAgent(a);
        setSharedFiles(shared);
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

  const chatTopRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Génération initiale (1 message assistant seul) → scroll en haut pour voir l'analyse
    if (chatMessages.length === 1 && chatMessages[0]?.role === 'assistant') {
      chatTopRef.current?.scrollIntoView({ behavior: 'smooth' });
    } else {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatMessages]);

  // Intercepter TOUTE navigation dès que le panel de réponse est ouvert
  useEffect(() => {
    if (!showReply) return;

    // Bouton back navigateur
    window.history.pushState(null, '', window.location.href);
    const onPop = () => { setShowLeaveModal(true); setPendingNav(`/mailbox/${agentId}`); window.history.pushState(null, '', window.location.href); };
    window.addEventListener('popstate', onPop);

    // Tous les clics sur des liens (Navbar, etc.) — phase de capture
    const onLinkClick = (e: MouseEvent) => {
      const anchor = (e.target as HTMLElement).closest('a');
      if (!anchor || !anchor.href) return;
      try {
        const url = new URL(anchor.href);
        if (url.pathname === window.location.pathname) return; // même page, pas de souci
        e.preventDefault();
        e.stopPropagation();
        setShowLeaveModal(true);
        setPendingNav(url.pathname + url.search);
      } catch { /* URL invalide, ignorer */ }
    };
    document.addEventListener('click', onLinkClick, true);

    // Fermeture / rechargement de l'onglet
    const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', onBeforeUnload);

    return () => {
      window.removeEventListener('popstate', onPop);
      document.removeEventListener('click', onLinkClick, true);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [showReply, agentId]);

  // Intercepter le bouton back du navigateur quand il y a des messages
  useEffect(() => {
    if (!chatMessages.length) return;
    window.history.pushState(null, '', window.location.href);
    const onPop = () => { setShowLeaveModal(true); setPendingNav(`/mailbox/${agentId}`); window.history.pushState(null, '', window.location.href); };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [chatMessages.length, agentId]);

  // Intercepter le bouton back du navigateur quand il y a des messages
  useEffect(() => {
    if (!chatMessages.length) return;
    window.history.pushState(null, '', window.location.href);
    const onPop = () => { setShowLeaveModal(true); setPendingNav(`/mailbox/${agentId}`); window.history.pushState(null, '', window.location.href); };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [chatMessages.length, agentId]);

  const stripHtml = (html: string) => { const d = document.createElement('div'); d.innerHTML = html; return d.textContent || ''; };

  const handleNavAway = (dest: string) => {
    if (showReply || chatMessages.length > 0) { setShowLeaveModal(true); setPendingNav(dest); }
    else router.push(dest);
  };

  const confirmLeave = async () => {
    await saveChatMessages(`thread_${agentId}_${threadId}`, []);
    setShowLeaveModal(false);
    router.push(pendingNav || `/mailbox/${agentId}`);
  };

  const buildEmailContext = useCallback(() =>
    messages.slice(-3).filter((m) => !m.is_comment).map((m) => {
      const from = m.author?.email || m.author?.name || 'inconnu';
      const date = new Date(m.created_at * 1000).toLocaleString('fr-FR');
      return `De: ${from} — ${date}\n${stripHtml(m.body)}`;
    }).join('\n\n---\n\n'),
  [messages]);

  const selectDocuments = useCallback((emailContent: string): string[] => {
    const text = emailContent.toLowerCase();

    const categories: { keywords: string[]; docs: string[] }[] = [
      {
        keywords: ['devis', 'sur mesure', 'sur-mesure', 'dimensions', 'personnalisé', 'taille spéciale', 'mesure', 'mètres', 'm²', 'quote', 'custom', 'custom-made', 'bespoke'],
        docs: ['devis-sur-mesure-base-documentaire.txt', 'obligations-tva-zephyr.docx', 'format-json-devis.txt'],
      },
      {
        keywords: ['retour', 'retourner', 'rembourser', 'remboursement', 'échange', 'échanger', 'rétractation', 'annuler', 'return', 'refund', 'exchange'],
        docs: ['POLITIQUE DE RETOURS.docx', 'template-echange-erreur-client.txt'],
      },
      {
        keywords: ['livraison', 'colis', 'suivi', 'expédition', 'reçu', 'pas reçu', 'transporteur', 'mondial relay', 'colissimo', 'chronopost', 'tracking', 'delivery', 'shipping', 'parcel'],
        docs: ['POLITIQUE EXPEDITION.docx', 'template-colis-non-recu.txt'],
      },
      {
        keywords: ['garantie', 'défaut', 'endommagé', 'cassé', 'déchiré', 'abîmé', 'usure', 'usé', 'décoloré', 'troué', 'warranty', 'damaged', 'broken', 'torn'],
        docs: ['template-garantie-diagnostic.txt'],
      },
      {
        keywords: ['produit', 'filet', 'voile', 'taille', 'couleur', 'installation', 'fixer', 'fixation', 'mât', 'corde', 'accessoire', 'product', 'net', 'sail', 'size', 'color'],
        docs: ['catalogue-LFC.txt', 'FT-Filets-LFC.pdf', 'FT-Coco-LFC.pdf', 'Fiches_Techniques_Accessoires.pdf'],
      },
      {
        keywords: ['tva', 'facture', 'ht', 'hors taxe', 'professionnel', 'entreprise', 'société', 'siret', 'intracommunautaire', 'vat', 'invoice', 'tax'],
        docs: ['obligations-tva-zephyr.docx'],
      },
      {
        keywords: ['cgv', 'conditions', 'droit', 'légal', 'rétractation', 'médiation', 'terms', 'legal'],
        docs: ['CGV.docx'],
      },
    ];

    const matched = new Set<string>();
    for (const cat of categories) {
      if (cat.keywords.some((kw) => text.includes(kw))) {
        cat.docs.forEach((d) => matched.add(d));
      }
    }

    // Fallback : si aucun mot-clé détecté, inclure catalogue + CGV
    if (matched.size === 0) {
      ['catalogue-LFC.txt', 'CGV.docx'].forEach((d) => matched.add(d));
    }

    return Array.from(matched);
  }, []);

  const buildDocumentsContext = useCallback((): string => {
    if (!agent) return '';

    const emailContext = buildEmailContext();
    const fullEmailText = `${subject} ${emailContext}`;
    const relevantDocNames = selectDocuments(fullEmailText);

    const allFiles = [
      ...agent.files.map((f) => ({ name: f.name, content: f.content, shared: false })),
      ...sharedFiles.map((f) => ({ name: f.name, content: f.content, shared: true })),
    ];

    const selectedFiles = allFiles.filter((f) =>
      relevantDocNames.some((docName) => f.name.toLowerCase().includes(docName.toLowerCase()) || docName.toLowerCase().includes(f.name.toLowerCase()))
    );

    const knownDocNames = [
      'devis-sur-mesure-base-documentaire.txt', 'obligations-tva-zephyr.docx', 'format-json-devis.txt',
      'POLITIQUE DE RETOURS.docx', 'template-echange-erreur-client.txt',
      'POLITIQUE EXPEDITION.docx', 'template-colis-non-recu.txt',
      'template-garantie-diagnostic.txt',
      'catalogue-LFC.txt', 'FT-Filets-LFC.pdf', 'FT-Coco-LFC.pdf', 'Fiches_Techniques_Accessoires.pdf',
      'CGV.docx',
    ];
    const unknownFiles = allFiles.filter((f) =>
      !knownDocNames.some((docName) => f.name.toLowerCase().includes(docName.toLowerCase()) || docName.toLowerCase().includes(f.name.toLowerCase()))
    );

    const filesToInclude = [...unknownFiles, ...selectedFiles];
    return filesToInclude.map((f) => f.shared ? `[Partagé: ${f.name}]\n${f.content}` : `[${f.name}]\n${f.content}`).join('\n\n');
  }, [agent, sharedFiles, subject, buildEmailContext, selectDocuments]);

  const buildSystemPrompt = useCallback((forDraft = false): string => {
    if (!agent) return '';

    const emailContext = buildEmailContext();
    const workflowRule = `RÈGLE PRIORITAIRE — WORKFLOW OBLIGATOIRE :\nTu ne dois JAMAIS générer directement un brouillon de mail. Tu dois TOUJOURS commencer par l'ANALYSE (type, urgence, résumé, contexte, points d'attention, conformité DGCCRF), puis proposer un brouillon, puis tes questions. Ces 3 éléments doivent apparaître dans ta PREMIÈRE réponse à chaque nouveau mail client. Si tu ne fais pas l'analyse avant le brouillon, ta réponse est incorrecte.\n\n`;
    const knowledgeInstructions = `\nDes documents de référence te sont fournis au début de la conversation. Consulte-les systématiquement avant de répondre : tarifs, délais, conditions, informations produits. Si une information s'y trouve, utilise-la directement sans l'inventer. Si elle n'y est pas, indique-le clairement.\n`;
    const base = `${workflowRule}Tu es l'agent "${agent.name}" (${agent.email}).\n\n${agent.instructions || ''}${knowledgeInstructions}\n\nCONVERSATION EMAIL — Sujet: ${subject}\n\n${emailContext}`;
    if (forDraft) return `${base}\n\nPeu importe tes instructions habituelles de structure : tu dois renvoyer UNIQUEMENT le corps de l'email de réponse prêt à envoyer. Pas d'analyse, pas de section BROUILLON, pas de titre, pas de markdown (pas de **, *, #). Commence directement par la formule de politesse (ex: "Bonjour ...") et termine par la signature.`;
    return `${base}${draft.trim() ? `\n\nBROUILLON ACTUEL:\n${draft}` : ''}`;
  }, [agent, subject, draft, buildEmailContext]);

  const cleanDraftContent = (raw: string): string => {
    // Si Claude a inclus une section BROUILLON DE RÉPONSE, extraire uniquement cette partie
    const brouillonMatch = raw.match(/\*?\*?BROUILLON\s+DE\s+R[EÉ]PONSE\s*:?\*?\*?\s*\n+([\s\S]+)/i);
    if (brouillonMatch) return brouillonMatch[1].trim();
    // Si le message est identifié comme mail final (étape 3), couper tout avant "Bonjour"
    const isFinalEmail = /[EÉ]TAPE\s*3|MAIL\s+FINAL|R[EÉ]PONSE\s+FINALE/i.test(raw);
    if (isFinalEmail) {
      const bonjourIdx = raw.search(/bonjour/i);
      if (bonjourIdx !== -1) return raw.slice(bonjourIdx).trim();
    }
    // Supprimer section d'analyse en tête si présente
    const analyseMatch = raw.match(/\*?\*?[A-ZÀÉÈÊ\s]+:?\*?\*?[\s\S]*?\n\n([\s\S]+)/);
    if (analyseMatch && /^(bonjour|chère|cher|madame|monsieur|hello)/i.test(analyseMatch[1])) {
      return analyseMatch[1].trim();
    }
    return raw.trim();
  };

  const cleanDraftResponse = (text: string): string => {
    let result = text;

    // 1. ÉTAPE : si mail final, supprimer tout ce qui précède "Bonjour"
    const isFinalEmail = /[EÉ]TAPE\s*3|MAIL\s+FINAL|R[EÉ]PONSE\s+FINALE/i.test(result);
    if (isFinalEmail) {
      const idx = result.search(/bonjour/i);
      if (idx !== -1) result = result.slice(idx);
    }

    // 2. SIGNATURE : supprimer la ligne de signature et les lignes vides qui suivent
    const sigPattern = /\n[^\n]*(cordialement|bien à vous|bien cordialement|l'équipe|le service client|à votre disposition|belle journée|bonne journée|excellente journée|nous vous souhaitons|à bientôt)[^\n]*(\n\s*)*/i;
    result = result.replace(sigPattern, '');

    return result.trim();
  };

  // Détecte si le dernier message Claude signale que le brouillon est prêt (pas de questions)
  const isDraftReady = (content: string): boolean => {
    const lower = content.toLowerCase();
    // Avec header "QUESTIONS :"
    const questionsMatch = content.match(/QUESTIONS?\s*:([^\n]*(?:\n(?!ÉTAPE|BROUILLON|##)[^\n]*)*)/i);
    if (questionsMatch) {
      const answer = questionsMatch[1].toLowerCase();
      if (/pas de question|aucune question|sans question|pas de questions particulière|aucune question particulière/.test(answer)) return true;
    }
    // Sans header — Claude dit directement "Pas de question supplémentaire"
    return /pas de question suppl|aucune question suppl|pas de questions suppl|tu valides ce brouillon/.test(lower);
  };

  const renderMarkdown = (text: string) => ({
    __html: text
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*\n]+)\*/g, '<em>$1</em>'),
  });

  const streamChat = useCallback(async (sys: string, msgs: { role: string; content: string }[], onChunk: (text: string) => void, model?: string, documents?: string): Promise<string> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
    try {
      const res = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ systemPrompt: sys, messages: msgs, model, documents }), signal: controller.signal });
      if (!res.ok || !res.body) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Erreur serveur'); }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let full = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        full += chunk;
        onChunk(full);
      }
      if (full.startsWith('__ERROR__')) throw new Error(full.slice(9));
      return full;
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') throw new Error('Délai dépassé (45s) — réessayez');
      throw e;
    } finally {
      clearTimeout(timeout);
    }
  }, []);

  const generateDraft = useCallback(async () => {
    if (!messages.length || isGeneratingDraft) return;
    setIsGeneratingDraft(true);
    const streamId = crypto.randomUUID();
    const streamMsg: ChatMessage = { id: streamId, role: 'assistant', content: '', timestamp: new Date().toISOString() };
    setChatMessages((prev) => [...prev, streamMsg]);
    try {
      const sys = buildSystemPrompt(false);
      const docs = buildDocumentsContext();
      const full = await streamChat(sys, [
        { role: 'user', content: 'ÉTAPE 1' },
      ], (text) => {
        setChatMessages((prev) => prev.map((m) => m.id === streamId ? { ...m, content: text } : m));
      }, 'sonnet', docs);
      const extracted = cleanDraftContent(full);
      setDraft(extracted);
      setDraftValidated(false);
      setDraftReadyToValidate(isDraftReady(full));
      setChatMessages((prev) => {
        const updated = prev.map((m) => m.id === streamId ? { ...m, content: full } : m);
        saveChatMessages(`thread_${agentId}_${threadId}`, updated);
        return updated;
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Erreur de connexion.';
      setChatMessages((prev) => prev.map((m) => m.id === streamId ? { ...m, content: `Erreur : ${msg}` } : m));
    }
    finally { setIsGeneratingDraft(false); }
  }, [messages.length, isGeneratingDraft, buildSystemPrompt, buildDocumentsContext, streamChat, agentId, threadId]);

  const handleOpenReply = useCallback(async () => {
    setShowReply(true);
    setDraft('');
    setDraftValidated(false);
    setDraftReadyToValidate(false);
    await saveChatMessages(`thread_${agentId}_${threadId}`, []);
    setChatMessages([]);
    generateDraft();
  }, [agentId, threadId, generateDraft]);

  const sendMessage = async () => {
    if (!chatInput.trim() || !agent || isLoading) return;
    const userMsg: ChatMessage = { id: crypto.randomUUID(), role: 'user', content: chatInput.trim(), timestamp: new Date().toISOString() };
    const updated = [...chatMessages, userMsg];
    setChatMessages(updated); setChatInput(''); setIsLoading(true);
    const streamId = crypto.randomUUID();
    const streamMsg: ChatMessage = { id: streamId, role: 'assistant', content: '', timestamp: new Date().toISOString() };
    setChatMessages((prev) => [...prev, streamMsg]);
    try {
      const sys = buildSystemPrompt(false);
      const docs = buildDocumentsContext();
      // Limiter à 6 derniers messages pour réduire les coûts (le contexte email est dans le system prompt)
      const trimmed = updated.slice(-6).map((m) => ({ role: m.role, content: m.content }));
      const full = await streamChat(sys, trimmed, (text) => {
        setChatMessages((prev) => prev.map((m) => m.id === streamId ? { ...m, content: text } : m));
      }, undefined, docs);
      const extracted = cleanDraftContent(full);
      if (extracted.trim()) { setDraft(extracted); setDraftValidated(false); }
      setDraftReadyToValidate(isDraftReady(full));
      setChatMessages((prev) => {
        const final = prev.map((m) => m.id === streamId ? { ...m, content: full } : m);
        saveChatMessages(`thread_${agentId}_${threadId}`, final);
        return final;
      });
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : 'Erreur de connexion.';
      setChatMessages((prev) => {
        const final = prev.map((m) => m.id === streamId ? { ...m, content: `Erreur : ${errMsg}` } : m);
        saveChatMessages(`thread_${agentId}_${threadId}`, final);
        return final;
      });
    } finally { setIsLoading(false); }
  };

  const generateQuote = async () => {
    if (isGeneratingQuote) return;
    setIsGeneratingQuote(true); setQuoteModal('loading'); setQuoteError('');
    try {
      const check = await fetch(`/api/frontapp/summary?conversation_id=${threadId}`).then((r) => r.json());
      if (!check.quote_ready) { setQuoteError(check.quote_ready_reason || 'Informations insuffisantes.'); setQuoteModal('error'); return; }
      const sys = buildSystemPrompt(false);
      const docs = buildDocumentsContext();
      const rawExtract = await streamChat(sys, [{ role: 'user', content: `Extrais les informations de cette conversation pour créer un devis Pennylane.\n\nRÈGLES :\n- Filets sur mesure : type="product", unitPrice=prix HT/m2, quantity=surface totale m2, description="Quantité : X | Total m2 : Y | Délai : environ 14 jours", label="COULEUR - LxH m - Description"\n- Transport : type="transport", label="Transport sur mesure", unitPrice=prix HT, quantity=1\n- Remise transport : type="transport_discount", unitPrice=prix négatif, quantity=1\n- Accessoires : type="free"\n\nRéponds UNIQUEMENT avec un JSON valide (sans markdown) :\n{"customer":{"type":"individual","firstName":"","lastName":"","email":"","phone":"","address":{"street":"","zipCode":"","city":"","country":"FR"}},"lines":[{"type":"product","label":"","quantity":0,"unitPrice":0,"vatRate":"FR_200","description":""}],"subject":"","freeText":""}` }], () => {}, undefined, docs);
      let quoteData: Record<string, unknown>;
      try {
        const raw = rawExtract.trim().replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim();
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
    const cleanedDraft = cleanDraftResponse(draft);
    try {
      const endpoint = currentQuote ? '/api/frontapp/draft-with-quote' : '/api/frontapp/send';
      const payload = currentQuote
        ? { conversation_id: threadId, body: cleanedDraft, pdf_url: currentQuote.pdfUrl, quote_number: currentQuote.quoteNumber }
        : { conversationId: threadId, body: cleanedDraft };
      const data = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).then((r) => r.json());
      if (data.error) { alert(`Erreur: ${data.error}`); return; }
      setHasDraft(true);
      // Invalide le cache draft pour que la liste reflète immédiatement
      fetch('/api/frontapp/drafts', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversation_id: threadId }) }).catch(() => {});
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
        <button onClick={() => handleNavAway(`/mailbox/${agentId}`)} className="text-xs text-gray-400 hover:text-gray-600 mb-1 inline-block">
          ← {agent.name}
        </button>
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
                <div key={msg.id} className={`rounded-xl border p-5 ${
                  msg.is_comment ? 'bg-amber-50 border-amber-200'
                  : msg.is_inbound ? 'bg-white border-gray-200'
                  : 'bg-gray-50 border-gray-100'
                }`}>
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <span className={`text-xs px-2 py-0.5 rounded font-medium ${
                        msg.is_comment ? 'bg-amber-100 text-amber-700'
                        : msg.is_inbound ? 'bg-blue-50 text-blue-600'
                        : 'bg-gray-100 text-gray-500'
                      }`}>
                        {msg.is_comment ? '💬 Note interne' : msg.is_inbound ? 'Reçu' : 'Envoyé'}
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
            ) : (() => {
              const displayed = messages.slice(-3);
              const hidden = messages.length - displayed.length;
              return (<>
                {hidden > 0 && (
                  <div className="rounded-lg bg-blue-50 border border-blue-100 px-3 py-2 text-xs text-blue-600 text-center">
                    {hidden} message{hidden > 1 ? 's' : ''} plus ancien{hidden > 1 ? 's' : ''} non affiché{hidden > 1 ? 's' : ''} —{' '}
                    <a href={`https://app.frontapp.com/open/${threadId}`} target="_blank" rel="noopener noreferrer" className="underline font-medium">voir dans FrontApp →</a>
                  </div>
                )}
                {displayed.map((msg) => (
              <div key={msg.id} className={`rounded-lg border px-3 py-3 ${
                msg.is_comment ? 'bg-amber-50 border-amber-200'
                : msg.is_inbound ? 'bg-white border-gray-200'
                : 'bg-gray-50 border-gray-100'
              }`}>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-1.5">
                    <span className={`text-xs px-1.5 py-px rounded font-medium ${
                      msg.is_comment ? 'bg-amber-100 text-amber-700'
                      : msg.is_inbound ? 'bg-blue-50 text-blue-600'
                      : 'bg-gray-100 text-gray-500'
                    }`}>
                      {msg.is_comment ? '💬' : msg.is_inbound ? 'Reçu' : 'Envoyé'}
                    </span>
                    <span className="text-xs font-semibold text-gray-700 truncate max-w-[120px]">{msg.author?.name || msg.author?.email || 'Inconnu'}</span>
                  </div>
                  <span className="text-xs text-gray-400 flex-shrink-0">{new Date(msg.created_at * 1000).toLocaleDateString('fr-FR')}</span>
                </div>
                <div className="email-body text-xs" dangerouslySetInnerHTML={{ __html: msg.body }} />
              </div>
            ))}
              </>);
            })()}
          </div>

          {/* Droite — brouillon (2/3) + chat (1/3) */}
          <div className="flex-1 flex flex-col gap-3 min-w-0 overflow-visible">

            {/* Discussion unifiée — pleine hauteur */}
            <div className="bg-white rounded-xl border border-gray-200 flex flex-col flex-1 min-h-0 overflow-hidden">
              <div className="flex-1 overflow-y-auto p-4 space-y-3">
                <div ref={chatTopRef} />
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
                {(isLoading || isGeneratingDraft) && chatMessages[chatMessages.length - 1]?.role !== 'assistant' && (
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
              <button
                onClick={() => quoteReady ? generateQuote() : setShowQuoteWarning(true)}
                disabled={isGeneratingQuote}
                className={`rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${
                  quoteReady
                    ? 'bg-amber-500 hover:bg-amber-600 text-white'
                    : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                }`}
              >
                {isGeneratingQuote ? 'Génération devis...' : currentQuote ? '✓ Devis créé' : '⬡ Générer le devis PDF'}
              </button>

              <div className="flex items-center gap-3">
                <p className="text-xs text-gray-400 italic">Crée un brouillon dans Front — rien n&apos;est envoyé au client</p>

                {/* 🟢 Charger dans Front */}
                <button
                  onClick={handleSendDraft}
                  disabled={isSending || !draft.trim()}
                  className={`rounded-lg px-5 py-2 text-sm font-bold text-white transition-colors flex-shrink-0 ${
                    isSending || !draft.trim() ? 'bg-gray-300 cursor-not-allowed' : 'bg-green-600 hover:bg-green-700'
                  }`}
                >
                  {isSending ? 'Envoi...' : currentQuote ? '↑ Charger brouillon + devis dans Front' : '↑ Charger dans Front'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── MODALE QUITTER ── */}
      {showLeaveModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 backdrop-blur-sm">
          <div className="bg-white rounded-2xl border border-gray-200 shadow-xl p-8 max-w-sm w-full mx-4 text-center">
            <div className="w-12 h-12 rounded-full bg-red-50 flex items-center justify-center mx-auto mb-4 text-xl">⚠️</div>
            <h2 className="text-lg font-bold text-gray-900 mb-2">Quitter cette conversation ?</h2>
            <p className="text-sm text-gray-500 mb-6">Le brouillon et la discussion avec Claude seront supprimés. Cette action est irréversible.</p>
            <div className="flex gap-3">
              <button onClick={() => setShowLeaveModal(false)}
                className="flex-1 rounded-lg border border-gray-200 px-4 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors">
                Rester
              </button>
              <button onClick={confirmLeave}
                className="flex-1 rounded-lg bg-red-500 hover:bg-red-600 px-4 py-2.5 text-sm font-bold text-white transition-colors">
                Oui, quitter
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── MODALE AVERTISSEMENT DEVIS ── */}
      {showQuoteWarning && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 backdrop-blur-sm">
          <div className="bg-white rounded-2xl border border-gray-200 shadow-xl p-8 max-w-sm w-full mx-4 text-center">
            <div className="w-12 h-12 rounded-full bg-amber-50 flex items-center justify-center mx-auto mb-4 text-2xl">⚠️</div>
            <h2 className="text-lg font-bold text-gray-900 mb-2">Devis non recommandé</h2>
            <p className="text-sm text-gray-500 mb-6">
              {quoteReadyReason || 'Le client n\'a pas encore validé de proposition chiffrée.'}<br /><br />
              Vous pouvez tout de même générer le devis, mais il risque de manquer des informations.
            </p>
            <div className="flex gap-3">
              <button onClick={() => setShowQuoteWarning(false)}
                className="flex-1 rounded-lg border border-gray-200 px-4 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors">
                Annuler
              </button>
              <button onClick={() => { setShowQuoteWarning(false); generateQuote(); }}
                className="flex-1 rounded-lg bg-amber-500 hover:bg-amber-600 px-4 py-2.5 text-sm font-bold text-white transition-colors">
                Générer quand même
              </button>
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
