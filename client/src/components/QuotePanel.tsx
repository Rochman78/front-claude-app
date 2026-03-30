import { useState, useEffect } from 'react';
import {
  type ExtractedQuote,
  getMissingFields,
  formatQuotePayload,
  extractQuoteData,
} from '../utils/extractQuoteData';

const API_BASE = window.location.origin;

/** Langue par défaut de chaque boutique */
const STORE_LANG: Record<string, string> = {
  LFC: 'fr', LVO: 'fr', COCO: 'fr', MON: 'fr', UNI: 'fr',
  TAR: 'de', HET: 'nl', RED: 'es', RETE: 'it',
};

interface QuotePanelProps {
  /** Texte brut de tous les messages Claude */
  claudeText: string;
  /** Fil de mails Front App (texte brut) */
  mailThread: string;
  /** Contexte client depuis Front App */
  customerEmail: string;
  customerName: string;
  storeCode: string;
  inboxName: string;
  onSendMessage: (message: string) => void;
  onQuoteCreated?: (pdfUrl: string, quoteNumber: string, pennylaneUrl: string) => void;
  /** Callback pour exposer handleClick au parent */
  onRegisterClick?: (fn: () => void) => void;
  /** Callback pour récupérer les messages Front SDK (fallback si mailThread vide) */
  onListMessages?: () => Promise<{ results: unknown[] }>;
}

interface QuoteResult {
  pdfUrl: string;
  pennylaneUrl: string;
  quoteNumber: string;
}

type PanelState = 'idle' | 'missing' | 'form' | 'creating' | 'done';

export default function QuotePanel({
  claudeText, mailThread, customerEmail, customerName, storeCode, inboxName, onSendMessage, onQuoteCreated, onRegisterClick, onListMessages,
}: QuotePanelProps) {
  const [state, setState] = useState<PanelState>('idle');
  const [result, setResult] = useState<QuoteResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formData, setFormData] = useState<Record<string, string>>({});
  const [extractedQuote, setExtractedQuote] = useState<ExtractedQuote | null>(null);

  // Exposer handleClick au parent — DOIT être avant tout return conditionnel
  useEffect(() => {
    onRegisterClick?.(handleClick);
  });

  // ─── ÉTAT 3 : Devis créé ───
  if (state === 'done' && result) {
    return (
      <div className="quote-panel">
        <p style={{ fontSize: '13px' }}>
          Le devis {result.quoteNumber} a bien été généré depuis Pennylane et chargé dans le brouillon.
        </p>
        <a
          href={result.pennylaneUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="btn-primary"
          style={{ display: 'block', textAlign: 'center', textDecoration: 'none', marginTop: '10px' }}
        >
          Modifier le devis PDF
        </a>
      </div>
    );
  }

  // ─── ÉTAT 2 : Génération en cours ───
  if (state === 'creating') {
    return (
      <div className="quote-panel">
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div className="loading-spinner" />
          <span style={{ fontSize: '13px' }}>Génération du devis en cours...</span>
        </div>
      </div>
    );
  }

  // ─── Infos manquantes ───
  if (state === 'missing' && extractedQuote) {
    const merged = mergeFormData(extractedQuote, formData);
    const missing = getMissingFields(merged);

    if (missing.length === 0) {
      // Plus rien ne manque après saisie → lancer la création
      handleCreate(merged);
      return (
        <div className="quote-panel">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div className="loading-spinner" />
            <span style={{ fontSize: '13px' }}>Génération du devis en cours...</span>
          </div>
        </div>
      );
    }

    return (
      <div className="quote-panel">
        <div className="quote-panel-header">Informations manquantes</div>
        <div className="quote-panel-missing">
          <ul>
            {missing.map((f) => (
              <li key={f.key}>{f.label}</li>
            ))}
          </ul>
        </div>
        {error && <p style={{ color: 'var(--error)', fontSize: '12px', marginBottom: '8px' }}>{error}</p>}
        <div className="quote-panel-actions">
          <button className="btn-secondary" onClick={() => setState('form')}>
            Remplir manuellement
          </button>
          <button
            className="btn-secondary"
            onClick={() => {
              const list = missing.map((f) => f.label).join(', ');
              onSendMessage(`Rédige un brouillon pour demander au client les informations manquantes pour le devis : ${list}`);
              setState('idle');
            }}
          >
            Demander au client
          </button>
          <button
            className="btn-secondary"
            onClick={() => handleCreate(merged)}
          >
            Ignorer
          </button>
        </div>
      </div>
    );
  }

  // ─── Formulaire saisie manuelle ───
  if (state === 'form' && extractedQuote) {
    const merged = mergeFormData(extractedQuote, formData);
    const missing = getMissingFields(merged);

    return (
      <div className="quote-panel">
        <div className="quote-panel-header">Compléter les informations</div>
        <div className="quote-panel-form">
          {missing.map((field) => (
            <div key={field.key} className="form-field">
              <label>{field.label}</label>
              <input
                type="text"
                value={formData[field.key] || ''}
                onChange={(e) => setFormData({ ...formData, [field.key]: e.target.value })}
                placeholder={field.label}
              />
            </div>
          ))}
        </div>
        <div className="quote-panel-actions">
          <button className="btn-secondary" onClick={() => setState('missing')}>Annuler</button>
          <button className="btn-primary" onClick={() => setState('missing')} style={{ width: 'auto' }}>Valider</button>
        </div>
      </div>
    );
  }

  // ─── ÉTAT 1 : idle — pas de bouton ici, il est dans le container PluginMain ───
  if (state === 'idle') {
    return error ? <p style={{ color: 'var(--error)', fontSize: '12px' }}>{error}</p> : null;
  }
  return null;

  async function handleClick() {
    setError(null);

    // Si mailThread est vide (conversation restaurée depuis cache), récupérer depuis le SDK
    let resolvedMailThread = mailThread;
    if (!resolvedMailThread && onListMessages) {
      try {
        const msgsRes = await onListMessages();
        const msgs = msgsRes.results as unknown as { content?: { body?: string } }[];
        resolvedMailThread = msgs.map((m) => {
          const body = m.content?.body || '';
          return body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        }).filter(Boolean).join('\n\n');
        console.log('[QuotePanel] mailThread recovered from SDK:', resolvedMailThread.length, 'chars');
      } catch { /* fallback: pas de mailThread */ }
    }

    // Extraire les données : chiffrage depuis Claude, infos client depuis le fil de mails
    // mailThread en premier pour prioriser les infos les plus récentes du client
    const fullText = resolvedMailThread + '\n\n---\n\n' + claudeText;
    const allEmailsInFullText = fullText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
    console.log('[QuotePanel] fullText length:', fullText.length);
    console.log('[QuotePanel] mailThread length:', mailThread.length);
    console.log('[QuotePanel] claudeText length:', claudeText.length);
    console.log('[QuotePanel] allEmails in fullText:', allEmailsInFullText);
    console.log('[QuotePanel] customerEmail from SDK:', customerEmail);
    console.log('[QuotePanel] fullText first 800 chars:', fullText.substring(0, 800));

    const quote = extractQuoteData(fullText, { customerEmail, customerName, storeCode });

    if (!quote) {
      setError('Aucun chiffrage détecté dans la réponse de Claude. Demandez-lui d\'abord de calculer le devis.');
      return;
    }

    console.log('[QuotePanel] extracted quote email:', quote.customer?.email);
    setExtractedQuote(quote);
    const missing = getMissingFields(mergeFormData(quote, formData));

    if (missing.length > 0) {
      setState('missing');
    } else {
      handleCreate(quote);
    }
  }

  async function handleCreate(quote: ExtractedQuote) {
    setState('creating');
    setError(null);

    try {
      const payload = formatQuotePayload(quote, storeCode, inboxName);

      // Traduire les labels produit si la boutique n'est pas française
      const storeLang = STORE_LANG[storeCode] || 'fr';
      if (storeLang !== 'fr') {
        const langNames: Record<string, string> = {
          es: 'espagnol', de: 'allemand', nl: 'néerlandais', it: 'italien', en: 'anglais',
        };
        const targetLang = langNames[storeLang] || storeLang;
        for (const line of payload.lines) {
          if (line.label) {
            try {
              const res = await fetch(`${API_BASE}/api/plugin/translate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  text: line.label,
                  mailContent: `Traduis ce nom de produit en ${targetLang}. Le client parle ${targetLang}. Texte du mail du client : produit en ${targetLang}.`,
                }),
              });
              if (res.ok) {
                const data = await res.json();
                line.label = data.translatedText;
                console.log(`[QuotePanel] label traduit → ${storeLang}:`, line.label);
              }
            } catch { /* garder le label français en fallback */ }
          }
        }
        // Traduire le sujet du devis (remplacement direct, pas besoin d'API)
        if (payload.subject) {
          const subjectMap: Record<string, { devis: string; surMesure: string; standard: string }> = {
            es: { devis: 'Presupuesto', surMesure: 'red a medida', standard: 'red estándar' },
            de: { devis: 'Angebot', surMesure: 'Tarnnetz nach Maß', standard: 'Tarnnetz Standard' },
            nl: { devis: 'Offerte', surMesure: 'net op maat', standard: 'net standaard' },
            it: { devis: 'Preventivo', surMesure: 'rete su misura', standard: 'rete standard' },
            en: { devis: 'Quote', surMesure: 'custom net', standard: 'standard net' },
          };
          const map = subjectMap[storeLang];
          if (map) {
            payload.subject = payload.subject
              .replace(/^Devis/i, map.devis)
              .replace(/filet sur mesure/i, map.surMesure)
              .replace(/filet standard/i, map.standard);
          }
        }
      }

      const response = await fetch(`${API_BASE}/api/plugin/create-quote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || `Erreur ${response.status}`);
      }

      const data = await response.json();
      const quoteResult: QuoteResult = {
        pdfUrl: data.pdfUrl || '',
        pennylaneUrl: data.pennylaneUrl || '',
        quoteNumber: data.quoteNumber || '',
      };

      setResult(quoteResult);
      setState('done');
      onQuoteCreated?.(quoteResult.pdfUrl, quoteResult.quoteNumber, quoteResult.pennylaneUrl);
    } catch (err) {
      console.error('[plugin] create-quote error:', err);
      setError(err instanceof Error ? err.message : 'Erreur inconnue');
      setState('idle');
    }
  }
}

function mergeFormData(quote: ExtractedQuote, formData: Record<string, string>): ExtractedQuote {
  if (Object.keys(formData).length === 0) return quote;

  const customer = { ...(quote.customer || { type: 'individual' as const }) };

  if (formData.firstName) customer.firstName = formData.firstName;
  if (formData.lastName) customer.lastName = formData.lastName;
  if (formData.name) customer.name = formData.name;
  if (formData.email) customer.email = formData.email;
  if (formData.phone) customer.phone = formData.phone;
  if (formData.vatNumber) customer.vatNumber = formData.vatNumber;

  if (formData.address || formData.postalCode || formData.city) {
    customer.address = {
      ...(customer.address || {}),
      ...(formData.address ? { address: formData.address } : {}),
      ...(formData.postalCode ? { postalCode: formData.postalCode } : {}),
      ...(formData.city ? { city: formData.city } : {}),
    };
  }

  return { ...quote, customer };
}
