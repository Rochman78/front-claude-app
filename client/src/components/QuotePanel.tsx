import { useState, useEffect } from 'react';
import {
  type ExtractedQuote,
  extractQuoteData,
} from '../utils/extractQuoteData';

const API_BASE = window.location.origin;

/** Langue par défaut de chaque boutique */
const STORE_LANG: Record<string, string> = {
  LFC: 'fr', LVO: 'fr', COCO: 'fr', MON: 'fr', UNI: 'fr',
  TAR: 'de', HET: 'nl', RED: 'es', RETE: 'it',
};

interface QuotePanelProps {
  claudeText: string;
  mailThread: string;
  customerEmail: string;
  customerName: string;
  storeCode: string;
  inboxName: string;
  onSendMessage: (message: string) => void;
  onQuoteCreated?: (pdfUrl: string, quoteNumber: string, pennylaneUrl: string) => void;
  onRegisterClick?: (fn: () => void) => void;
  onListMessages?: () => Promise<{ results: unknown[] }>;
}

interface QuoteResult {
  pdfUrl: string;
  pennylaneUrl: string;
  quoteNumber: string;
}

/** Données du formulaire de vérification */
interface VerifyFormData {
  // Client
  clientType: 'individual' | 'company';
  firstName: string;
  lastName: string;
  companyName: string;
  email: string;
  phone: string;
  vatNumber: string;
  // Adresse
  street: string;
  postalCode: string;
  city: string;
  country: string;
  // Lignes produit (tableau)
  lines: { label: string; quantity: string; unitPrice: string; unit: string }[];
  // TVA
  vatPercent: string;
  // Livraison offerte
  freeShipping: boolean;
  // Sujet
  subject: string;
}

type PanelState = 'idle' | 'verify' | 'creating' | 'done';

export default function QuotePanel({
  claudeText, mailThread, customerEmail, customerName, storeCode, inboxName, onSendMessage: _onSendMessage, onQuoteCreated, onRegisterClick, onListMessages,
}: QuotePanelProps) {
  const [state, setState] = useState<PanelState>('idle');
  const [result, setResult] = useState<QuoteResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, setExtractedQuote] = useState<ExtractedQuote | null>(null);
  const [verifyForm, setVerifyForm] = useState<VerifyFormData | null>(null);

  // Exposer handleClick au parent
  useEffect(() => {
    onRegisterClick?.(handleClick);
  });

  // ─── Devis créé ───
  if (state === 'done' && result) {
    return (
      <div className="quote-panel">
        <p style={{ fontSize: '13px' }}>
          Le devis {result.quoteNumber} a bien été généré depuis Pennylane.
        </p>
        <a href={result.pennylaneUrl} target="_blank" rel="noopener noreferrer"
          className="btn-primary" style={{ display: 'block', textAlign: 'center', textDecoration: 'none', marginTop: '10px' }}>
          Modifier le devis PDF
        </a>
      </div>
    );
  }

  // ─── Génération en cours ───
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

  // ─── Formulaire de vérification ───
  if (state === 'verify' && verifyForm) {
    const f = verifyForm;
    const upd = (key: keyof VerifyFormData, val: string | boolean) =>
      setVerifyForm({ ...f, [key]: val } as VerifyFormData);
    const updLine = (idx: number, key: string, val: string) => {
      const newLines = [...f.lines];
      newLines[idx] = { ...newLines[idx], [key]: val };
      setVerifyForm({ ...f, lines: newLines });
    };
    const addLine = () => {
      setVerifyForm({ ...f, lines: [...f.lines, { label: '', quantity: '1', unitPrice: '0', unit: 'm2' }] });
    };
    const removeLine = (idx: number) => {
      if (f.lines.length <= 1) return;
      setVerifyForm({ ...f, lines: f.lines.filter((_, i) => i !== idx) });
    };

    const inputStyle = { width: '100%', padding: '4px 6px', fontSize: '12px', border: '1px solid #ddd', borderRadius: '4px' };
    const labelStyle = { fontSize: '11px', color: '#666', marginBottom: '2px', display: 'block' as const };
    const rowStyle = { display: 'flex', gap: '8px', marginBottom: '6px' };

    return (
      <div className="quote-panel" style={{ fontSize: '12px' }}>
        <div className="quote-panel-header">Vérification du devis</div>

        {/* Client */}
        <div style={{ marginBottom: '10px', padding: '8px', background: '#f9f9f9', borderRadius: '6px' }}>
          <div style={{ fontWeight: 600, marginBottom: '6px', fontSize: '12px' }}>Client</div>
          <div style={rowStyle}>
            <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: '4px' }}>
              <input type="radio" checked={f.clientType === 'individual'} onChange={() => upd('clientType', 'individual')} /> Particulier
            </label>
            <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: '4px' }}>
              <input type="radio" checked={f.clientType === 'company'} onChange={() => upd('clientType', 'company')} /> Entreprise
            </label>
          </div>
          {f.clientType === 'company' && (
            <div style={rowStyle}>
              <div style={{ flex: 1 }}><span style={labelStyle}>Raison sociale</span><input style={inputStyle} value={f.companyName} onChange={(e) => upd('companyName', e.target.value)} /></div>
              <div style={{ flex: 1 }}><span style={labelStyle}>N° TVA intra</span><input style={inputStyle} value={f.vatNumber} onChange={(e) => upd('vatNumber', e.target.value)} /></div>
            </div>
          )}
          <div style={rowStyle}>
            <div style={{ flex: 1 }}><span style={labelStyle}>Prénom</span><input style={inputStyle} value={f.firstName} onChange={(e) => upd('firstName', e.target.value)} /></div>
            <div style={{ flex: 1 }}><span style={labelStyle}>Nom</span><input style={inputStyle} value={f.lastName} onChange={(e) => upd('lastName', e.target.value)} /></div>
          </div>
          <div style={rowStyle}>
            <div style={{ flex: 1 }}><span style={labelStyle}>Email</span><input style={inputStyle} value={f.email} onChange={(e) => upd('email', e.target.value)} /></div>
            <div style={{ flex: 1 }}><span style={labelStyle}>Téléphone</span><input style={inputStyle} value={f.phone} onChange={(e) => upd('phone', e.target.value)} /></div>
          </div>
        </div>

        {/* Adresse */}
        <div style={{ marginBottom: '10px', padding: '8px', background: '#f9f9f9', borderRadius: '6px' }}>
          <div style={{ fontWeight: 600, marginBottom: '6px', fontSize: '12px' }}>Adresse</div>
          <div style={rowStyle}>
            <div style={{ flex: 1 }}><span style={labelStyle}>Rue</span><input style={inputStyle} value={f.street} onChange={(e) => upd('street', e.target.value)} /></div>
          </div>
          <div style={rowStyle}>
            <div style={{ flex: 1 }}><span style={labelStyle}>Code postal</span><input style={inputStyle} value={f.postalCode} onChange={(e) => upd('postalCode', e.target.value)} /></div>
            <div style={{ flex: 1 }}><span style={labelStyle}>Ville</span><input style={inputStyle} value={f.city} onChange={(e) => upd('city', e.target.value)} /></div>
            <div style={{ flex: 1 }}><span style={labelStyle}>Pays</span><input style={inputStyle} value={f.country} onChange={(e) => upd('country', e.target.value)} /></div>
          </div>
        </div>

        {/* Produits */}
        <div style={{ marginBottom: '10px', padding: '8px', background: '#f9f9f9', borderRadius: '6px' }}>
          <div style={{ fontWeight: 600, marginBottom: '6px', fontSize: '12px' }}>Produits</div>
          {f.lines.map((line, idx) => (
            <div key={idx} style={{ ...rowStyle, alignItems: 'flex-end' }}>
              <div style={{ flex: 3 }}><span style={labelStyle}>Produit</span><input style={inputStyle} value={line.label} onChange={(e) => updLine(idx, 'label', e.target.value)} /></div>
              <div style={{ flex: 1 }}><span style={labelStyle}>Qté</span><input style={inputStyle} value={line.quantity} onChange={(e) => updLine(idx, 'quantity', e.target.value)} /></div>
              <div style={{ flex: 1 }}><span style={labelStyle}>Prix HT</span><input style={inputStyle} value={line.unitPrice} onChange={(e) => updLine(idx, 'unitPrice', e.target.value)} /></div>
              <div style={{ flex: 1 }}>
                <span style={labelStyle}>Unité</span>
                <select style={{ ...inputStyle, padding: '3px 4px' }} value={line.unit} onChange={(e) => updLine(idx, 'unit', e.target.value)}>
                  <option value="m2">m²</option>
                  <option value="piece">unité</option>
                </select>
              </div>
              {f.lines.length > 1 && (
                <button onClick={() => removeLine(idx)} style={{ border: 'none', background: 'none', color: '#e53e3e', cursor: 'pointer', fontSize: '16px', padding: '0 4px' }}>×</button>
              )}
            </div>
          ))}
          <button onClick={addLine} style={{ fontSize: '11px', color: '#4a90d9', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0' }}>
            + Ajouter un produit
          </button>
        </div>

        {/* TVA + Livraison */}
        <div style={{ marginBottom: '10px', padding: '8px', background: '#f9f9f9', borderRadius: '6px' }}>
          <div style={rowStyle}>
            <div style={{ flex: 1 }}><span style={labelStyle}>TVA (%)</span><input style={inputStyle} value={f.vatPercent} onChange={(e) => upd('vatPercent', e.target.value)} /></div>
            <div style={{ flex: 1 }}><span style={labelStyle}>Sujet du devis</span><input style={inputStyle} value={f.subject} onChange={(e) => upd('subject', e.target.value)} /></div>
          </div>
          <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: '4px', marginTop: '4px' }}>
            <input type="checkbox" checked={f.freeShipping} onChange={(e) => upd('freeShipping', e.target.checked)} /> Livraison offerte
          </label>
        </div>

        {/* Récap */}
        {(() => {
          const p = (v: string) => parseFloat((v || '0').replace(',', '.'));
          const r2 = (n: number) => Math.round(n * 100) / 100;
          const totalHT = f.lines.reduce((s, l) => s + r2(p(l.quantity) * p(l.unitPrice)), 0);
          const vat = parseFloat(f.vatPercent || '0');
          const totalTTC = totalHT * (1 + vat / 100);
          return (
            <div style={{ marginBottom: '10px', padding: '8px', background: '#eef7ee', borderRadius: '6px', fontSize: '12px' }}>
              <div>Total HT : <strong>{totalHT.toFixed(2)} €</strong></div>
              <div>TVA ({vat}%) : <strong>{(totalHT * vat / 100).toFixed(2)} €</strong></div>
              <div>Total TTC : <strong>{totalTTC.toFixed(2)} €</strong></div>
            </div>
          );
        })()}

        {error && <p style={{ color: 'var(--error)', fontSize: '12px', marginBottom: '8px' }}>{error}</p>}

        <div className="quote-panel-actions">
          <button className="btn-secondary" onClick={() => { setState('idle'); setError(null); }}>Annuler</button>
          <button className="btn-primary" onClick={() => handleCreateFromForm()} style={{ width: 'auto' }}>Générer le devis</button>
        </div>
      </div>
    );
  }

  // ─── idle ───
  if (state === 'idle') {
    return error ? <p style={{ color: 'var(--error)', fontSize: '12px' }}>{error}</p> : null;
  }
  return null;

  async function handleClick() {
    setError(null);

    let resolvedMailThread = mailThread;
    if (!resolvedMailThread && onListMessages) {
      try {
        const msgsRes = await onListMessages();
        const msgs = msgsRes.results as unknown as { content?: { body?: string } }[];
        resolvedMailThread = msgs.map((m) => {
          const body = m.content?.body || '';
          return body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        }).filter(Boolean).join('\n\n');
      } catch { /* fallback */ }
    }

    const fullText = resolvedMailThread + '\n\n---\n\n' + claudeText;
    // Chercher le message Claude qui contient le chiffrage (du plus récent au plus ancien)
    const claudeMsgs = claudeText.split('\n\n---\n\n').reverse();
    let quoteClaudeMsg = '';
    for (const msg of claudeMsgs) {
      if (/(?:total\s*(?:ht|ttc|hors)|prix\s*unitaire|€\s*\/\s*m[²2]|\d+[.,]\d+\s*€)/i.test(msg)) {
        quoteClaudeMsg = msg;
        break;
      }
    }
    if (!quoteClaudeMsg) quoteClaudeMsg = claudeMsgs[0] || claudeText;

    const quote = extractQuoteData(fullText, { customerEmail, customerName, storeCode, claudeText: quoteClaudeMsg });

    if (!quote) {
      setError('Aucun chiffrage détecté dans la réponse de Claude. Demandez-lui d\'abord de calculer le devis.');
      return;
    }

    setExtractedQuote(quote);

    // Construire le formulaire de vérification pré-rempli
    const c = quote.customer;
    const isCatalogue = quote.lines.some(l => l.unit === 'piece');

    setVerifyForm({
      clientType: c?.type || 'individual',
      firstName: c?.firstName || '',
      lastName: c?.lastName || '',
      companyName: c?.name || '',
      email: c?.email || '',
      phone: c?.phone || '',
      vatNumber: c?.vatNumber || '',
      street: c?.address?.address || '',
      postalCode: c?.address?.postalCode || '',
      city: c?.address?.city || '',
      country: c?.address?.country || '',
      lines: quote.lines
        .filter(l => l.type === 'product')
        .map(l => ({ label: l.label, quantity: String(l.quantity), unitPrice: l.unitPrice, unit: l.unit || 'm2' })),
      vatPercent: quote.extractedVatPercent !== null && quote.extractedVatPercent !== undefined ? String(quote.extractedVatPercent) : '20',
      freeShipping: quote.lines.some(l => l.type === 'transport'),
      subject: quote.subject || (isCatalogue ? 'Devis filet standard' : 'Devis filet sur mesure'),
    });

    setState('verify');
  }

  async function handleCreateFromForm() {
    if (!verifyForm) return;
    setState('creating');
    setError(null);

    try {
      const f = verifyForm;

      // Construire les lignes produit
      const allLines: { type: string; label: string; description?: string; quantity: number; unitPrice: number; unit: string; vatRate: string }[] = f.lines.map(l => ({
        type: 'product',
        label: l.label,
        description: l.unit === 'm2' ? `Quantité : 1 | Total m² : ${l.quantity} | Délai de production + livraison : environ 14 jours` : undefined,
        quantity: parseFloat(l.quantity.replace(',', '.')) || 1,
        unitPrice: parseFloat(l.unitPrice.replace(',', '.')) || 0,
        unit: l.unit,
        vatRate: '',
      }));

      // Ajouter livraison si offerte
      if (f.freeShipping) {
        allLines.push({ type: 'transport', label: 'Transport sur mesure', quantity: 1, unitPrice: 19.99, unit: 'piece', vatRate: '' });
        allLines.push({ type: 'transport_discount', label: 'Remise transport sur mesure', quantity: 1, unitPrice: -19.99, unit: 'piece', vatRate: '' });
      }

      // Déterminer le code TVA
      const vatPercent = parseFloat(f.vatPercent) || 0;
      const country = f.vatNumber?.match(/^([A-Z]{2})/)?.[1] || f.country || 'FR';
      const vatCode = vatPercent === 0 ? 'tax_free_0' : `${country}_${Math.round(vatPercent * 10)}`;

      // Appliquer le vatCode à toutes les lignes
      for (const line of allLines) {
        line.vatRate = vatCode;
      }

      // Construire le payload
      const payload = {
        customer: {
          type: f.clientType,
          firstName: f.firstName,
          lastName: f.lastName,
          name: f.clientType === 'company' ? f.companyName : undefined,
          email: f.email,
          phone: f.phone,
          vatNumber: f.clientType === 'company' ? f.vatNumber : undefined,
          address: (f.street || f.postalCode || f.city) ? {
            street: f.street,
            zipCode: f.postalCode,
            city: f.city,
            country,
          } : undefined,
        },
        lines: allLines,
        subject: f.subject,
        inboxName,
      };

      // Traduire labels si boutique non-FR
      const storeLang = STORE_LANG[storeCode] || 'fr';
      if (storeLang !== 'fr') {
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
              const dimPart = line.label.match(/(\d+[.,]?\d*x\d+[.,]?\d*\s*m)/i)?.[1] || '';
              const couleurPart = line.label.match(/^([^-]+)\s*-/)?.[1]?.trim() || '';
              const parts = [couleurPart, dimPart, map.surMesure].filter(Boolean);
              line.label = parts.join(' — ');
            } else if (line.label && /^Transport sur mesure$/i.test(line.label)) {
              line.label = map.transport;
            } else if (line.label && /^Remise transport sur mesure$/i.test(line.label)) {
              line.label = map.remise;
            }
            if (line.description && /Quantité|Total m²|Délai/i.test(line.description)) {
              const qtyMatch = line.description.match(/Quantité\s*:\s*(\d+)/);
              const m2Match = line.description.match(/Total m²\s*:\s*([\d.,]+)/);
              line.description = map.description.replace('{qty}', qtyMatch?.[1] || '1').replace('{m2}', m2Match?.[1] || String(line.quantity));
            }
          }
        }
        // Traduire le sujet
        const subjectMap: Record<string, { devis: string; surMesure: string; standard: string }> = {
          es: { devis: 'Presupuesto', surMesure: 'red a medida', standard: 'red estándar' },
          de: { devis: 'Angebot', surMesure: 'Tarnnetz nach Maß', standard: 'Tarnnetz Standard' },
          nl: { devis: 'Offerte', surMesure: 'net op maat', standard: 'net standaard' },
          it: { devis: 'Preventivo', surMesure: 'rete su misura', standard: 'rete standard' },
          en: { devis: 'Quote', surMesure: 'custom net', standard: 'standard net' },
        };
        const sMap = subjectMap[storeLang];
        if (sMap && payload.subject) {
          payload.subject = payload.subject.replace(/^Devis/i, sMap.devis).replace(/filet sur mesure/i, sMap.surMesure).replace(/filet standard/i, sMap.standard);
        }
      }

      console.log('[QuotePanel] final payload:', JSON.stringify(payload, null, 2));

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
      setState('verify');
    }
  }
}
