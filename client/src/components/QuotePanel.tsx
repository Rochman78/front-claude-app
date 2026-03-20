import { useState } from 'react';
import {
  type ExtractedQuote,
  getMissingFields,
  formatQuotePayload,
} from '../utils/extractQuoteData';

const API_BASE = window.location.origin;

interface QuotePanelProps {
  quote: ExtractedQuote;
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

type PanelState = 'ready' | 'missing' | 'form' | 'creating' | 'done';

export default function QuotePanel({ quote, storeCode, inboxName, onSendMessage, onQuoteCreated }: QuotePanelProps) {
  const [state, setState] = useState<PanelState>('ready');
  const [result, setResult] = useState<QuoteResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formData, setFormData] = useState<Record<string, string>>({});

  const mergedQuote = mergeFormData(quote, formData);
  const missingFields = getMissingFields(mergedQuote);

  // Déterminer l'état initial si pas encore d'action utilisateur
  const effectiveState = (state === 'ready' && missingFields.length > 0) ? 'missing' : state;

  // ─── ÉTAT 3 : Devis créé ───
  if (effectiveState === 'done' && result) {
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
  if (effectiveState === 'creating') {
    return (
      <div className="quote-panel">
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div className="loading-spinner" />
          <span style={{ fontSize: '13px' }}>Génération du devis en cours...</span>
        </div>
      </div>
    );
  }

  // ─── Infos manquantes (liste) ───
  if (effectiveState === 'missing') {
    return (
      <div className="quote-panel">
        <div className="quote-panel-header">Devis détecté</div>
        <div className="quote-panel-missing">
          <p>Informations manquantes pour le devis PDF :</p>
          <ul>
            {missingFields.map((f) => (
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
              const list = missingFields.map((f) => f.label).join(', ');
              onSendMessage(`Rédige un brouillon pour demander au client les informations manquantes pour le devis : ${list}`);
            }}
          >
            Demander au client
          </button>
        </div>
      </div>
    );
  }

  // ─── Formulaire saisie manuelle ───
  if (effectiveState === 'form') {
    return (
      <div className="quote-panel">
        <div className="quote-panel-header">Compléter les informations</div>
        <div className="quote-panel-form">
          {missingFields.map((field) => (
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
          <button className="btn-primary" onClick={() => setState('ready')} style={{ width: 'auto' }}>Valider</button>
        </div>
      </div>
    );
  }

  // ─── ÉTAT 1 : Devis détecté, prêt à générer ───
  return (
    <div className="quote-panel">
      <div className="quote-panel-header">Devis détecté</div>
      {error && <p style={{ color: 'var(--error)', fontSize: '12px', marginBottom: '8px' }}>{error}</p>}
      <button className="btn-primary" onClick={handleCreate} style={{ marginTop: '4px' }}>
        Générer devis PDF
      </button>
    </div>
  );

  async function handleCreate() {
    setState('creating');
    setError(null);

    try {
      const payload = formatQuotePayload(mergedQuote, storeCode, inboxName);
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

      onSendMessage(
        `Le devis PDF ${quoteResult.quoteNumber} a été créé et sera joint au mail. ` +
        `Réécris le brouillon en 4 lignes max : salutation, ci-joint le devis, ` +
        `retourner le devis signé + virement aux coordonnées du devis, ` +
        `délai fabrication et livraison environ 14 jours dès réception du règlement.`
      );
    } catch (err) {
      console.error('[plugin] create-quote error:', err);
      setError(err instanceof Error ? err.message : 'Erreur inconnue');
      setState('ready');
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
