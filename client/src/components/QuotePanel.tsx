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
  onQuoteCreated?: (pdfUrl: string, quoteNumber: string) => void;
}

interface QuoteResult {
  pdfUrl: string;
  pennylaneUrl: string;
  quoteNumber: string;
  amountTTC: number;
}

export default function QuotePanel({ quote, storeCode, inboxName, onSendMessage, onQuoteCreated }: QuotePanelProps) {
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
          <p>Devis {result.quoteNumber} — {Number(result.amountTTC || 0).toFixed(2)} € TTC</p>
          <p style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '4px' }}>
            Le PDF sera joint automatiquement au brouillon lors du push.
          </p>
        </div>
        <div className="quote-panel-actions" style={{ marginTop: '10px' }}>
          {result.pdfUrl && (
            <a
              href={result.pdfUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-secondary"
              style={{ textAlign: 'center', textDecoration: 'none' }}
            >
              Consulter le PDF
            </a>
          )}
          <a
            href={result.pennylaneUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-primary"
            style={{ textAlign: 'center', textDecoration: 'none', flex: 1 }}
          >
            Voir dans Pennylane
          </a>
        </div>
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
              // Re-render recalcule missingFields avec les données saisies
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
              {line.quantity} x {parseFloat(line.unitPrice || '0').toFixed(2)} €
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
      const quoteResult: QuoteResult = {
        pdfUrl: data.pdfUrl || '',
        pennylaneUrl: data.pennylaneUrl || '',
        quoteNumber: data.quoteNumber || '',
        amountTTC: Number(data.amountTTC || data.amount || 0),
      };
      setResult(quoteResult);

      // Remonter le PDF au parent pour le DraftFinal
      onQuoteCreated?.(quoteResult.pdfUrl, quoteResult.quoteNumber);

      // Envoyer un message auto à Claude pour rédiger le brouillon avec le devis
      onSendMessage(
        `Le devis PDF ${quoteResult.quoteNumber} est créé et sera joint au mail en pièce jointe. ` +
        `Rédige un nouveau brouillon qui dit au client que son devis est en pièce jointe. ` +
        `Récapitule la commande (produit, dimensions, prix). ` +
        `IMPORTANT — utilise EXACTEMENT cette formulation pour la fin du mail (en paragraphes, pas de tirets ni listes à puces) :\n\n` +
        `"Pour donner suite à ce devis, il vous suffit de nous retourner le devis signé ou votre accord par retour de mail, puis de procéder au virement bancaire aux coordonnées indiquées sur le devis.\n\n` +
        `La mise en production sera lancée dès réception du règlement, avec un délai de fabrication et de livraison d'environ 14 jours.\n\n` +
        `N'hésitez pas à nous contacter si vous avez la moindre question."`
      );
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
