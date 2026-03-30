import { useState, useEffect } from 'react';
import {
  type ExtractedQuote,
  type MissingField,
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
  const [missingFieldsSnapshot, setMissingFieldsSnapshot] = useState<MissingField[]>([]);

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

    return (
      <div className="quote-panel">
        <div className="quote-panel-header">Informations manquantes</div>
        {missing.length > 0 ? (
          <div className="quote-panel-missing">
            <ul>
              {missing.map((f) => (
                <li key={f.key}>{f.label}</li>
              ))}
            </ul>
          </div>
        ) : (
          <p style={{ fontSize: '12px', color: 'var(--success)', marginBottom: '8px' }}>Toutes les informations sont complètes.</p>
        )}
        {error && <p style={{ color: 'var(--error)', fontSize: '12px', marginBottom: '8px' }}>{error}</p>}
        <div className="quote-panel-actions">
          <button className="btn-secondary" onClick={() => {
            setMissingFieldsSnapshot(missing);
            setState('form');
          }}>
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
            {missing.length === 0 ? 'Générer le devis' : 'Ignorer'}
          </button>
        </div>
      </div>
    );
  }

  // ─── Formulaire saisie manuelle ───
  if (state === 'form' && extractedQuote) {
    // Utiliser le snapshot des champs manquants (figé au moment du clic "Remplir")
    const fieldsToShow = missingFieldsSnapshot.length > 0 ? missingFieldsSnapshot : getMissingFields(extractedQuote);

    return (
      <div className="quote-panel">
        <div className="quote-panel-header">Compléter les informations</div>
        <div className="quote-panel-form">
          {fieldsToShow.map((field) => (
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
          <button className="btn-primary" onClick={() => {
            const merged = mergeFormData(extractedQuote, formData);
            handleCreate(merged);
          }} style={{ width: 'auto' }}>Générer le devis</button>
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

      // Traduire les labels si la boutique n'est pas française
      const storeLang = STORE_LANG[storeCode] || 'fr';
      if (storeLang !== 'fr') {
        // Mapping direct pour les labels (pas d'API — évite les commentaires de Claude)
        const labelMap: Record<string, { surMesure: string; transport: string; remise: string; description: string }> = {
          es: { surMesure: 'Red de camuflaje reforzada a medida', transport: 'Transporte a medida', remise: 'Descuento transporte a medida', description: 'Cantidad : {qty} | Total m² : {m2} | Plazo de producción + entrega : aprox. 14 días' },
          de: { surMesure: 'Tarnnetz verstärkt nach Maß', transport: 'Versand nach Maß', remise: 'Versandrabatt nach Maß', description: 'Menge : {qty} | Gesamt m² : {m2} | Produktions- + Lieferzeit : ca. 14 Tage' },
          nl: { surMesure: 'Camouflagenet versterkt op maat', transport: 'Verzending op maat', remise: 'Verzendkorting op maat', description: 'Aantal : {qty} | Totaal m² : {m2} | Productie + levertijd : ca. 14 dagen' },
          it: { surMesure: 'Rete di camuffamento rinforzata su misura', transport: 'Trasporto su misura', remise: 'Sconto trasporto su misura', description: 'Quantità : {qty} | Totale m² : {m2} | Tempi di produzione + consegna : circa 14 giorni' },
          en: { surMesure: 'Reinforced camouflage net custom made', transport: 'Custom shipping', remise: 'Custom shipping discount', description: 'Quantity : {qty} | Total m² : {m2} | Production + delivery time : approx. 14 days' },
        };
        const map = labelMap[storeLang];
        if (map) {
          for (const line of payload.lines) {
            if (line.label && /filet de camouflage renforcé/i.test(line.label)) {
              // Extraire couleur et dimensions du label français
              const dimPart = line.label.match(/(\d+[.,]?\d*x\d+[.,]?\d*\s*m)/i)?.[1] || '';
              const couleurPart = line.label.match(/^([^-]+)\s*-/)?.[1]?.trim() || '';
              const parts = [couleurPart, dimPart, map.surMesure].filter(Boolean);
              line.label = parts.join(' — ');
            } else if (line.label && /^Transport sur mesure$/i.test(line.label)) {
              line.label = map.transport;
            } else if (line.label && /^Remise transport sur mesure$/i.test(line.label)) {
              line.label = map.remise;
            }
            // Traduire la description (délai, quantité, m²)
            if (line.description && /Quantité|Total m²|Délai/i.test(line.description)) {
              const qtyMatch = line.description.match(/Quantité\s*:\s*(\d+)/);
              const m2Match = line.description.match(/Total m²\s*:\s*([\d.,]+)/);
              line.description = map.description
                .replace('{qty}', qtyMatch?.[1] || '1')
                .replace('{m2}', m2Match?.[1] || String(line.quantity));
            }
          }
        }

        // Traduire le sujet du devis (remplacement direct)
        if (payload.subject) {
          const subjectMap: Record<string, { devis: string; surMesure: string; standard: string }> = {
            es: { devis: 'Presupuesto', surMesure: 'red a medida', standard: 'red estándar' },
            de: { devis: 'Angebot', surMesure: 'Tarnnetz nach Maß', standard: 'Tarnnetz Standard' },
            nl: { devis: 'Offerte', surMesure: 'net op maat', standard: 'net standaard' },
            it: { devis: 'Preventivo', surMesure: 'rete su misura', standard: 'rete standard' },
            en: { devis: 'Quote', surMesure: 'custom net', standard: 'standard net' },
          };
          const sMap = subjectMap[storeLang];
          if (sMap) {
            payload.subject = payload.subject
              .replace(/^Devis/i, sMap.devis)
              .replace(/filet sur mesure/i, sMap.surMesure)
              .replace(/filet standard/i, sMap.standard);
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
