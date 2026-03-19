import { useState } from 'react';
import { type QuoteData, computeTotal } from '../utils/detectQuoteJson';

const API_BASE = window.location.origin;

interface QuoteBlockProps {
  quoteData: QuoteData;
  inboxName: string;
}

export default function QuoteBlock({ quoteData, inboxName }: QuoteBlockProps) {
  const [creating, setCreating] = useState(false);
  const [result, setResult] = useState<{ pdfUrl: string; quoteNumber: string; amountTTC: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { totalHT, totalTTC } = computeTotal(quoteData.lines);

  async function handleCreate() {
    setCreating(true);
    setError(null);

    try {
      const response = await fetch(`${API_BASE}/api/plugin/create-quote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer: quoteData.customer,
          lines: quoteData.lines,
          subject: quoteData.subject,
          deadline: quoteData.deadline,
          freeText: quoteData.freeText,
          inboxName,
        }),
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
      setError(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="quote-block">
      <div className="quote-block-header">Devis</div>

      {/* Récap des lignes */}
      <div className="quote-lines">
        {quoteData.lines?.map((line, i) => (
          <div key={i} className="quote-line">
            <span className="quote-line-label">{line.label}</span>
            <span className="quote-line-detail">
              {line.quantity} x {line.unitPrice.toFixed(2)} &euro;
            </span>
          </div>
        ))}
        <div className="quote-totals">
          <div className="quote-total-row">
            <span>Total HT</span>
            <span>{totalHT.toFixed(2)} &euro;</span>
          </div>
          <div className="quote-total-row total-ttc">
            <span>Total TTC</span>
            <span>{totalTTC.toFixed(2)} &euro;</span>
          </div>
        </div>
      </div>

      {error && (
        <p style={{ color: 'var(--error)', fontSize: '12px', margin: '8px 0' }}>{error}</p>
      )}

      {!result && (
        <button
          className="btn-primary"
          onClick={handleCreate}
          disabled={creating}
          style={{ marginTop: '10px' }}
        >
          {creating ? 'Création en cours...' : 'Créer devis Pennylane'}
        </button>
      )}

      {result && (
        <div className="quote-result">
          <p>Devis {result.quoteNumber} — {result.amountTTC.toFixed(2)} &euro; TTC</p>
          <a href={result.pdfUrl} target="_blank" rel="noopener noreferrer" className="quote-pdf-link">
            Voir le PDF
          </a>
        </div>
      )}
    </div>
  );
}
