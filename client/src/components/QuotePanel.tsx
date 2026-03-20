import { useState } from 'react';
import {
  type ExtractedQuote,
  getMissingFields,
  computeTotals,
  formatQuotePayload,
} from '../utils/extractQuoteData';

const API_BASE = window.location.origin;

interface QuotePanelProps {
  quote: ExtractedQuote;
  storeCode: string;
  inboxName: string;
  onSendMessage: (message: string) => void;
}

interface QuoteResult {
  pdfUrl: string;
  quoteNumber: string;
  amountTTC: number;
}

export default function QuotePanel({ quote, storeCode, inboxName, onSendMessage }: QuotePanelProps) {
  const [creating, setCreating] = useState(false);
  const [result, setResult] = useState<QuoteResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState<Record<string, string>>({});

  // Merger les données du formulaire dans le quote
  const mergedQuote = mergeFormData(quote, formData);
  const missingFields = getMissingFields(mergedQuote);
  const { totalHT, totalTTC } = computeTotals(mergedQuote.lines);

  // --- État 3 : Devis créé ---
  if (result) {
    return (
      <div className="quote-panel">
        <div className="quote-panel-header">Devis créé</div>
        <div className="quote-panel-result">
          <p>Devis {result.quoteNumber} — {result.amountTTC.toFixed(2)} € TTC</p>
          <a href={result.pdfUrl} target="_blank" rel="noopener noreferrer" className="quote-pdf-link">
            Voir le PDF
          </a>
        </div>
        <a
          href={result.pdfUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="btn-primary"
          style={{ display: 'block', textAlign: 'center', textDecoration: 'none', marginTop: '10px' }}
        >
          Voir le devis dans Pennylane
        </a>
      </div>
    );
  }

  // --- État 2 : Infos manquantes (sans formulaire) ---
  if (missingFields.length > 0 && !showForm) {
    return (
      <div className="quote-panel">
        <div className="quote-panel-header">Générer devis PDF</div>
        <div className="quote-panel-missing">
          <p>Informations manquantes pour le devis PDF :</p>
          <ul>
            {missingFields.map((f) => (
              <li key={f.key}>{f.label}</li>
            ))}
          </ul>
        </div>

        {error && (
          <p style={{ color: 'var(--error)', fontSize: '12px', marginBottom: '8px' }}>{error}</p>
        )}

        <div className="quote-panel-actions">
          <button className="btn-secondary" onClick={() => setShowForm(true)}>
            Remplir manuellement
          </button>
          <button
            className="btn-secondary"
            onClick={() => {
              const list = missingFields.map((f) => f.label).join(', ');
              onSendMessage(
                `Rédige un brouillon pour demander au client les informations manquantes pour le devis : ${list}`
              );
            }}
          >
            Demander au client
          </button>
        </div>
      </div>
    );
  }

  // --- État 2b : Formulaire infos manquantes ---
  if (missingFields.length > 0 && showForm) {
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
          <button className="btn-secondary" onClick={() => setShowForm(false)}>
            Annuler
          </button>
          <button
            className="btn-primary"
            onClick={() => {
              // Le re-render va recalculer missingFields avec les nouvelles données
              // Si tout est rempli, on passera à l'état 1
            }}
            style={{ width: 'auto' }}
          >
            Valider
          </button>
        </div>
      </div>
    );
  }

  // --- État 1 : Tout est complet → bouton créer ---
  return (
    <div className="quote-panel">
      <div className="quote-panel-header">Générer devis PDF</div>

      <div className="quote-lines">
        {mergedQuote.lines.map((line, i) => (
          <div key={i} className="quote-line">
            <span className="quote-line-label">{line.label}</span>
            <span className="quote-line-detail">
              {line.quantity} x {parseFloat(line.unitPrice).toFixed(2)} €
            </span>
          </div>
        ))}
        <div className="quote-totals">
          <div className="quote-total-row">
            <span>Total HT</span>
            <span>{totalHT.toFixed(2)} €</span>
          </div>
          <div className="quote-total-row total-ttc">
            <span>Total TTC</span>
            <span>{totalTTC.toFixed(2)} €</span>
          </div>
        </div>
      </div>

      {error && (
        <p style={{ color: 'var(--error)', fontSize: '12px', margin: '8px 0' }}>{error}</p>
      )}

      <button
        className="btn-primary"
        onClick={() => handleCreate(mergedQuote)}
        disabled={creating}
        style={{ marginTop: '10px' }}
      >
        {creating ? 'Création en cours...' : 'Générer devis PDF'}
      </button>
    </div>
  );

  async function handleCreate(q: ExtractedQuote) {
    setCreating(true);
    setError(null);

    try {
      const payload = formatQuotePayload(q, storeCode, inboxName);
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
      setResult({
        pdfUrl: data.pdfUrl,
        quoteNumber: data.quoteNumber,
        amountTTC: data.amountTTC,
      });
    } catch (err) {
      console.error('[plugin] create-quote error:', err);
      setError(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setCreating(false);
    }
  }
}

/**
 * Merge les données du formulaire dans le quote extrait.
 */
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
