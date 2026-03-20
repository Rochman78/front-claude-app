import { useState } from 'react';
import {
  type ExtractedQuote,
  getMissingFields,
  formatQuotePayload,
  extractQuoteData,
} from '../utils/extractQuoteData';

const API_BASE = window.location.origin;

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
  onQuoteCreated?: (pdfUrl: string, quoteNumber: string) => void;
}

interface QuoteResult {
  pdfUrl: string;
  pennylaneUrl: string;
  quoteNumber: string;
}

type PanelState = 'idle' | 'missing' | 'form' | 'creating' | 'done';

export default function QuotePanel({
  claudeText, mailThread, customerEmail, customerName, storeCode, inboxName, onSendMessage, onQuoteCreated,
}: QuotePanelProps) {
  const [state, setState] = useState<PanelState>('idle');
  const [result, setResult] = useState<QuoteResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formData, setFormData] = useState<Record<string, string>>({});
  const [extractedQuote, setExtractedQuote] = useState<ExtractedQuote | null>(null);

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

  // ─── ÉTAT 1 : Bouton par défaut (toujours visible) ───
  return (
    <div className="quote-panel">
      {error && <p style={{ color: 'var(--error)', fontSize: '12px', marginBottom: '8px' }}>{error}</p>}
      <button className="btn-primary" onClick={handleClick}>
        Générer devis PDF
      </button>
    </div>
  );

  function handleClick() {
    setError(null);

    // Extraire les données : chiffrage depuis Claude, infos client depuis le fil de mails
    // mailThread en premier pour prioriser les infos les plus récentes du client
    const fullText = mailThread + '\n\n---\n\n' + claudeText;
    const quote = extractQuoteData(fullText, { customerEmail, customerName, storeCode });

    if (!quote) {
      setError('Aucun chiffrage détecté dans la réponse de Claude. Demandez-lui d\'abord de calculer le devis.');
      return;
    }

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
      onQuoteCreated?.(quoteResult.pdfUrl, quoteResult.quoteNumber);
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
