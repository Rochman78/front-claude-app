import { useState, useEffect } from 'react';
import {
  type ExtractedQuote,
} from '../utils/extractQuoteData';

const API_BASE = window.location.origin;

/** Langue par défaut de chaque boutique */
const STORE_LANG: Record<string, string> = {
  LFC: 'fr', LVO: 'fr', COCO: 'fr', MON: 'fr', UNI: 'fr',
  TAR: 'de', HET: 'nl', RED: 'es', REDE: 'pt', RETE: 'it',
};

interface ImageSelection {
  data: string;
  mediaType: string;
  name: string;
  selected: boolean;
}

interface QuotePanelProps {
  claudeText: string;
  mailThread: string;
  customerEmail: string;
  customerName: string;
  storeCode: string;
  inboxName: string;
  frontConversationId: string;
  onSendMessage: (message: string) => void;
  onQuoteCreated?: (pdfUrl: string, quoteNumber: string, pennylaneUrl: string, totalTTC: number) => void;
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
  lines: { label: string; quantity: string; unitPrice: string; unit: string; type?: string; description?: string }[];
  // TVA
  vatPercent: string;
  // Remise globale
  discountPercent: string;
  // Livraison offerte
  freeShipping: boolean;
  // Sujet
  subject: string;
}

type PanelState = 'idle' | 'extracting' | 'verify' | 'creating' | 'done';

export default function QuotePanel({
  claudeText, mailThread, customerEmail, customerName, storeCode, inboxName, frontConversationId, onSendMessage: _onSendMessage, onQuoteCreated, onRegisterClick, onListMessages,
}: QuotePanelProps) {
  const [state, setState] = useState<PanelState>('idle');
  const [result, setResult] = useState<QuoteResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, setExtractedQuote] = useState<ExtractedQuote | null>(null);
  const [expectedTTC, setExpectedTTC] = useState<number | null>(null);
  const [verifyForm, setVerifyForm] = useState<VerifyFormData | null>(null);
  const [availableImages, setAvailableImages] = useState<ImageSelection[]>([]);
  // Trapèze : on n'utilise PAS l'extraction Claude pour les lignes produit
  // (Claude se trompe trop souvent : 4 côtés différents → calcul Héron, choix
  // de tranche, prix m²…). Identité client gardée, lignes vidées.
  const [isTrapeze, setIsTrapeze] = useState(false);
  const [showTrapezePopup, setShowTrapezePopup] = useState(false);

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

  // ─── Extraction des données en cours ───
  if (state === 'extracting') {
    return (
      <div className="quote-panel">
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div className="loading-spinner" />
          <span style={{ fontSize: '13px' }}>Extraction des données du devis...</span>
        </div>
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
      setVerifyForm({ ...f, lines: [...f.lines, { label: '', quantity: '1', unitPrice: '0', unit: 'm2', type: 'product' }] });
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

        {/* Popup bloquant pour les trapèzes : saisie manuelle obligatoire */}
        {showTrapezePopup && (
          <div
            style={{
              position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
              background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2500,
            }}
          >
            <div style={{
              background: 'white', borderRadius: '12px', padding: '20px', maxWidth: '460px', width: '92%',
              boxShadow: '0 4px 20px rgba(0,0,0,0.2)', color: '#000',
            }}>
              <h3 style={{ margin: '0 0 12px 0', fontSize: '15px', fontWeight: 700, color: '#9b2c2c' }}>
                ⚠ Trapèze détecté — saisie manuelle des lignes produit
              </h3>
              <p style={{ fontSize: '12.5px', lineHeight: 1.55, marginBottom: '10px' }}>
                Pour les filets trapèzes, Claude se trompe régulièrement sur :
              </p>
              <ul style={{ fontSize: '12.5px', lineHeight: 1.55, paddingLeft: '20px', marginBottom: '12px' }}>
                <li>les dimensions (4 côtés différents, calcul de surface via Héron)</li>
                <li>la tranche tarifaire (surface totale du devis)</li>
                <li>le prix HT/m² applicable</li>
              </ul>
              <p style={{ fontSize: '12.5px', lineHeight: 1.55, marginBottom: '14px' }}>
                Le formulaire ouvre les lignes produit <strong>vides</strong> — à toi de saisir les dimensions,
                la surface et le prix unitaire HT en croisant avec la grille <code>prix-ht-sur-mesure.txt</code>.
                L'identité client (nom, email, adresse) reste pré-remplie.
              </p>
              <button
                onClick={() => setShowTrapezePopup(false)}
                style={{
                  width: '100%', padding: '10px 16px', fontSize: '13px', fontWeight: 600,
                  border: 'none', borderRadius: '6px', background: '#e53e3e', color: 'white', cursor: 'pointer',
                }}
              >
                J'ai compris
              </button>
            </div>
          </div>
        )}

        {/* Bandeau permanent rappel trapèze, visible tant que le formulaire est ouvert */}
        {isTrapeze && (
          <div style={{
            background: '#fffbf0', border: '1px solid #f6e05e', borderRadius: '6px',
            padding: '8px 10px', margin: '6px 0 10px 0', fontSize: '11.5px', color: '#744210',
          }}>
            ⚠ <strong>Trapèze</strong> — lignes produit à saisir manuellement (Claude ne pré-remplit pas).
            Vérifie surface (Héron pour 3 côtés), tranche tarifaire (sur le TOTAL des m² sur-mesure du devis),
            et prix HT/m² dans <code>prix-ht-sur-mesure.txt</code>.
          </div>
        )}

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
              <div style={{ flex: 1 }}><span style={labelStyle}>N° TVA intra</span><input style={inputStyle} value={f.vatNumber} onChange={(e) => {
                const val = e.target.value;
                upd('vatNumber', val);
                // Si n° TVA intra renseigné et pays UE hors France → TVA 0% (LIC)
                const euCountries = ['AT','BE','BG','CY','CZ','DE','DK','EE','ES','FI','GR','HR','HU','IE','IT','LT','LU','LV','MT','NL','PL','PT','RO','SE','SI','SK'];
                const countryFromVat = val.replace(/[^A-Z]/g, '').substring(0, 2);
                const countryFromForm = f.country?.toUpperCase() || '';
                const country = countryFromVat || countryFromForm;
                if (val.trim().length >= 4 && euCountries.includes(country)) {
                  upd('vatPercent', '0');
                }
              }} /></div>
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
            <div style={{ flex: 1 }}><span style={labelStyle}>Remise (%)</span><input style={inputStyle} value={f.discountPercent} onChange={(e) => upd('discountPercent', e.target.value)} /></div>
          </div>
        </div>

        {/* Annexes images */}
        {availableImages.length > 0 && (
          <div style={{ marginBottom: '10px', padding: '8px', background: '#f9f9f9', borderRadius: '6px' }}>
            <div style={{ fontWeight: 600, marginBottom: '6px', fontSize: '12px' }}>Annexes (joindre au devis PDF)</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
              {availableImages.map((img, idx) => (
                <label key={idx} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
                  <img
                    src={`data:${img.mediaType};base64,${img.data}`}
                    alt={img.name}
                    style={{
                      width: '60px', height: '60px', objectFit: 'cover', borderRadius: '4px',
                      border: img.selected ? '2px solid #4a90d9' : '2px solid #ddd',
                      opacity: img.selected ? 1 : 0.6,
                    }}
                  />
                  <div style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
                    <input
                      type="checkbox"
                      checked={img.selected}
                      onChange={() => {
                        const updated = [...availableImages];
                        updated[idx] = { ...updated[idx], selected: !updated[idx].selected };
                        setAvailableImages(updated);
                      }}
                    />
                    <span style={{ fontSize: '10px', maxWidth: '60px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{img.name}</span>
                  </div>
                </label>
              ))}
            </div>
          </div>
        )}

        {/* Récap + vérification TTC */}
        {(() => {
          const p = (v: string) => parseFloat((v || '0').replace(',', '.'));
          const r2 = (n: number) => Math.round(n * 100) / 100;
          const totalHTBrut = f.lines.reduce((s, l) => s + r2(p(l.quantity) * p(l.unitPrice)), 0);
          const discount = parseFloat(f.discountPercent || '0');
          const discountAmount = r2(totalHTBrut * discount / 100);
          const totalHT = r2(totalHTBrut - discountAmount);
          const vat = parseFloat(f.vatPercent || '0');
          const totalTTC = r2(totalHT * (1 + vat / 100));
          const ttcMismatch = expectedTTC !== null && Math.abs(totalTTC - expectedTTC) > 1;
          return (
            <>
              <div style={{ marginBottom: '10px', padding: '8px', background: ttcMismatch ? '#fef2f2' : '#eef7ee', borderRadius: '6px', fontSize: '12px' }}>
                <div>Total HT brut : <strong>{totalHTBrut.toFixed(2)} €</strong></div>
                {discount > 0 && <div>Remise ({discount}%) : <strong>-{discountAmount.toFixed(2)} €</strong></div>}
                {discount > 0 && <div>Total HT après remise : <strong>{totalHT.toFixed(2)} €</strong></div>}
                {discount === 0 && <div>Total HT : <strong>{totalHT.toFixed(2)} €</strong></div>}
                <div>TVA ({vat}%) : <strong>{r2(totalHT * vat / 100).toFixed(2)} €</strong></div>
                <div>Total TTC : <strong>{totalTTC.toFixed(2)} €</strong></div>
                {expectedTTC !== null && (
                  <div style={{ marginTop: '4px', color: ttcMismatch ? '#e53e3e' : '#38a169', fontWeight: 600 }}>
                    {ttcMismatch
                      ? `⚠ TTC attendu (mail) : ${expectedTTC.toFixed(2)} € — écart de ${Math.abs(totalTTC - expectedTTC).toFixed(2)} €`
                      : `✓ TTC cohérent avec le mail (${expectedTTC.toFixed(2)} €)`}
                  </div>
                )}
              </div>
              {ttcMismatch && (
                <p style={{ color: '#e53e3e', fontSize: '12px', marginBottom: '8px', fontWeight: 600 }}>
                  Le montant TTC du devis ne correspond pas au chiffrage accepté par le client. Vérifiez les prix et quantités avant de générer.
                </p>
              )}
            </>
          );
        })()}

        {error && <p style={{ color: 'var(--error)', fontSize: '12px', marginBottom: '8px' }}>{error}</p>}

        {/* Vérification champs manquants */}
        {(() => {
          const missing: string[] = [];
          if (!f.firstName.trim()) missing.push('Prénom');
          if (!f.lastName.trim() && f.clientType === 'individual') missing.push('Nom');
          if (f.clientType === 'company' && !f.companyName.trim()) missing.push('Raison sociale');
          if (!f.email.trim()) missing.push('Email');
          if (!f.phone.trim()) missing.push('Téléphone');
          if (!f.street.trim()) missing.push('Rue');
          if (!f.postalCode.trim()) missing.push('Code postal');
          if (!f.city.trim()) missing.push('Ville');
          if (!f.country.trim()) missing.push('Pays');
          if (f.lines.length === 0 || !f.lines[0].label.trim()) missing.push('Produit');

          const hasPhone = !!f.phone.trim();
          const hasMissing = missing.length > 0;

          return (
            <>
              {!hasPhone && (
                <p style={{ color: '#e53e3e', fontSize: '12px', marginBottom: '8px', fontWeight: 600 }}>
                  Numéro de téléphone manquant — obligatoire pour générer le devis.
                </p>
              )}
              {hasMissing && hasPhone && (
                <p style={{ color: '#dd6b20', fontSize: '12px', marginBottom: '8px' }}>
                  Champs manquants : {missing.join(', ')}
                </p>
              )}
              <div className="quote-panel-actions">
                <button className="btn-secondary" onClick={() => { setState('idle'); setError(null); }}>Annuler</button>
                <button className="btn-primary" onClick={() => handleCreateFromForm()} disabled={!hasPhone} style={{ width: 'auto', opacity: hasPhone ? 1 : 0.5 }}>Générer le devis</button>
              </div>
            </>
          );
        })()}
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
    setState('extracting');

    // Détection trapèze sur le brouillon Claude. Si match, on affiche le popup
    // ET on vide les lignes produit après l'extract-quote (l'identité client
    // pré-remplie reste utile au collab). Regex large multi-langue :
    // trapèze, trapézoïdal (FR), trapezoid/trapezium (EN), trapezio (IT),
    // trapézio (PT), trapezförmig (DE), trapeziumvormig (NL), trapecio (ES).
    const trapezeDetected = /\btrap[eéè]?[zc]/i.test(claudeText || '');
    setIsTrapeze(trapezeDetected);
    if (trapezeDetected) {
      setShowTrapezePopup(true);
      console.log('[QuotePanel] TRAPÈZE détecté → lignes produit forcées à vide, saisie manuelle');
    }

    try {
      // Toujours récupérer le fil de mails depuis le SDK Front (plus fiable que le cache)
      let resolvedMailThread = mailThread;
      if (onListMessages) {
        try {
          const msgsRes = await onListMessages();
          const msgs = msgsRes.results as unknown as { content?: { body?: string }; author?: { name?: string }; is_inbound?: boolean }[];
          const freshThread = msgs.map((m) => {
            const body = m.content?.body || '';
            const text = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            const who = m.is_inbound ? 'CLIENT' : 'BOUTIQUE';
            const author = m.author?.name || '';
            return text ? `[${who}${author ? ' — ' + author : ''}] ${text}` : '';
          }).filter(Boolean).join('\n\n---\n\n');
          if (freshThread) resolvedMailThread = freshThread;
        } catch { /* fallback au mailThread prop */ }
      }

      // Appeler Claude pour extraire les données structurées du devis
      console.log('[QuotePanel] calling extract-quote API...');
      const response = await fetch(`${API_BASE}/api/plugin/extract-quote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          claudeText,
          mailThread: resolvedMailThread,
          customerEmail,
          customerName,
          storeCode,
        }),
      });

      let parsed: Record<string, unknown> | null = null;
      if (response.ok) {
        parsed = await response.json();
        console.log('[QuotePanel] extract-quote result:', parsed);
      } else {
        const err = await response.json().catch(() => ({ error: 'Erreur extraction' }));
        console.warn('[QuotePanel] extract-quote failed:', err);
      }

      // Sauver le TTC attendu (extrait du mail)
      if (parsed?.totalTTC !== undefined && parsed?.totalTTC !== null) {
        setExpectedTTC(parseFloat(String(parsed.totalTTC)) || null);
      } else {
        setExpectedTTC(null);
      }

      // Construire le formulaire pré-rempli (données Claude si dispo, sinon vide)
      const customer = parsed?.customer as Record<string, unknown> | undefined;
      const lines = (parsed?.lines as Record<string, unknown>[]) || [];
      const displayLines = lines.filter(l =>
        l.type !== 'transport' && l.type !== 'transport_discount' &&
        !(String(l.label || '').toLowerCase().match(/remise|discount|korting|rabatt|sconto|descuento/) && parseFloat(String(l.unitPrice || '0')) < 0)
      );
      const hasTransport = lines.some(l => l.type === 'transport');
      const isCatalogue = displayLines.some(l => l.unit === 'piece');

      setExtractedQuote(parsed as unknown as ExtractedQuote | null);

      setVerifyForm({
        clientType: (customer?.type === 'company' ? 'company' : 'individual'),
        firstName: String(customer?.firstName || ''),
        lastName: String(customer?.lastName || ''),
        companyName: String(customer?.companyName || customer?.name || ''),
        email: String(customer?.email || customerEmail || ''),
        phone: String(customer?.phone || ''),
        vatNumber: String(customer?.vatNumber || ''),
        street: String((customer?.address as Record<string, unknown>)?.address || ''),
        postalCode: String((customer?.address as Record<string, unknown>)?.postalCode || ''),
        city: String((customer?.address as Record<string, unknown>)?.city || ''),
        country: String((customer?.address as Record<string, unknown>)?.country || ''),
        lines: trapezeDetected
          // Trapèze : on FORCE une seule ligne vide pour saisie manuelle,
          // même si Claude avait produit des lignes (qui seraient probablement
          // fausses sur les dimensions / tranche / prix m²).
          ? [{ label: '', quantity: '1', unitPrice: '0', unit: 'm2', type: 'product' }]
          : displayLines.length > 0
          ? displayLines.map(l => ({
              label: String(l.label || ''),
              quantity: String(l.quantity || '1'),
              unitPrice: String(l.unitPrice || '0'),
              unit: String(l.unit || 'm2'),
              type: String(l.type || 'product'),
              description: l.description ? String(l.description) : undefined,
            }))
          : [{ label: '', quantity: '1', unitPrice: '0', unit: 'm2', type: 'product' }],
        vatPercent: parsed?.vatPercent !== undefined && parsed?.vatPercent !== null ? String(parsed.vatPercent) : '20',
        discountPercent: parsed?.discountPercent !== undefined && parsed?.discountPercent !== null ? String(parsed.discountPercent) : '0',
        freeShipping: hasTransport,
        subject: String(parsed?.subject || (isCatalogue ? 'Devis' : 'Devis')),
      });

      // Récupérer les images de la conversation pour les proposer en annexes
      try {
        const imgRes = await fetch(`${API_BASE}/api/plugin/conversation-images?front_conversation_id=${encodeURIComponent(frontConversationId)}`);
        if (imgRes.ok) {
          const imgData = await imgRes.json();
          if (imgData.images && imgData.images.length > 0) {
            setAvailableImages(imgData.images.map((img: { data: string; mediaType: string; name: string }) => ({ ...img, selected: false })));
            console.log(`[QuotePanel] ${imgData.images.length} images available for appendices`);
          } else {
            setAvailableImages([]);
          }
        }
      } catch { /* non bloquant */ }

      setState('verify');
    } catch (err) {
      console.error('[QuotePanel] handleClick error:', err);
      // En cas d'erreur, afficher quand même le formulaire vide
      setVerifyForm({
        clientType: 'individual',
        firstName: '',
        lastName: '',
        companyName: '',
        email: customerEmail || '',
        phone: '',
        vatNumber: '',
        street: '',
        postalCode: '',
        city: '',
        country: '',
        lines: [{ label: '', quantity: '1', unitPrice: '0', unit: 'm2', type: 'product' }],
        vatPercent: '20',
        discountPercent: '0',
        freeShipping: false,
        subject: 'Devis',
      });
      setState('verify');
    }
  }

  async function handleCreateFromForm() {
    if (!verifyForm) return;
    setState('creating');
    setError(null);

    try {
      const f = verifyForm;

      // Construire les lignes produit + accessoires
      // Tous les prix dans le formulaire sont en HT (Haiku les retourne en HT)
      // PAS de conversion ici — le prix est envoyé tel quel à Pennylane
      const vatPercent = parseFloat(f.vatPercent) || 0;

      // Total TTC calculé localement (même formule que le bloc d'aperçu l. 270-294)
      // pour persistance en BDD → scoring panel "Vérifier virement reçu".
      const _p = (v: string) => parseFloat((v || '0').replace(',', '.'));
      const _r2 = (n: number) => Math.round(n * 100) / 100;
      const _totalHTBrut = f.lines.reduce((s, l) => s + _r2(_p(l.quantity) * _p(l.unitPrice)), 0);
      const _discountAmount = _r2(_totalHTBrut * (parseFloat(f.discountPercent || '0')) / 100);
      const _totalHT = _r2(_totalHTBrut - _discountAmount);
      const totalTTC = _r2(_totalHT * (1 + vatPercent / 100));

      const allLines: { type: string; label: string; description?: string; quantity: number; unitPrice: number; unit: string; vatRate: string }[] = f.lines.map(l => ({
        type: l.type || 'product',
        label: l.label,
        description: (() => {
          if (!l.description) return undefined;
          // Pas de description si unit=piece (standard catalogue)
          if (l.unit === 'piece') return undefined;
          // Pas de description si la quantité est un entier (standard en m2 par erreur Sonnet)
          const qty = parseFloat(l.quantity.replace(',', '.')) || 0;
          if (qty > 0 && qty === Math.floor(qty) && qty <= 20) return undefined;
          return l.description;
        })(),
        quantity: parseFloat(l.quantity.replace(',', '.')) || 1,
        unitPrice: parseFloat(l.unitPrice.replace(',', '.')) || 0,
        unit: l.unit,
        vatRate: '',
      }));

      // Livraison offerte — plus de lignes transport/remise dans le devis
      // Pennylane exige le code pays en MAJUSCULES (ex: FR_200) sinon retourne une erreur
      // générique trompeuse sur invoice_lines. On force l'uppercase + slice(0,2) pour parer
      // aux saisies "France", "fr", "Fr-FR", etc.
      const rawCountry = f.vatNumber?.match(/^([A-Za-z]{2})/)?.[1] || f.country || 'FR';
      const country = String(rawCountry).toUpperCase().slice(0, 2);
      const vatCode = vatPercent === 0 ? 'exempt' : `${country}_${Math.round(vatPercent * 10)}`;

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
        freeText: undefined as string | undefined,
        discountPercent: parseFloat(f.discountPercent || '0') || undefined,
        inboxName,
      };

      // Mention légale obligatoire pour l'intracommunautaire (UE hors France, TVA 0%, n° TVA intra)
      const euCountries = ['AT','BE','BG','CY','CZ','DE','DK','EE','ES','FI','GR','HR','HU','IE','IT','LT','LU','LV','MT','NL','PL','PT','RO','SE','SI','SK'];
      if (vatPercent === 0 && euCountries.includes(country) && f.vatNumber) {
        payload.freeText = 'VAT exempt – Intra-Community supply – Article 138 of Directive 2006/112/EC.';
      }

      // Traduire labels si boutique non-FR
      const storeLang = STORE_LANG[storeCode] || 'fr';
      if (storeLang !== 'fr') {
        const labelMap: Record<string, { product: string; transport: string; remise: string; description: string }> = {
          es: { product: 'Red de camuflaje {shape} a medida', transport: 'Transporte a medida', remise: 'Descuento transporte a medida', description: 'Cantidad : {qty} | Total m² : {m2} | Plazo de producción + entrega : aprox. 21 días' },
          pt: { product: 'Rede de camuflagem {shape} por medida', transport: 'Transporte por medida', remise: 'Desconto de transporte por medida', description: 'Quantidade : {qty} | Total m² : {m2} | Prazo de produção + entrega : aprox. 21 dias' },
          de: { product: 'Tarnnetz {shape} nach Maß', transport: 'Versand nach Maß', remise: 'Versandrabatt nach Maß', description: 'Menge : {qty} | Gesamt m² : {m2} | Produktions- + Lieferzeit : ca. 21 Tage' },
          nl: { product: 'Camouflagenet {shape} op maat', transport: 'Verzending op maat', remise: 'Verzendkorting op maat', description: 'Aantal : {qty} | Totaal m² : {m2} | Productie + levertijd : ca. 21 dagen' },
          it: { product: 'Rete mimetica {shape} su misura', transport: 'Trasporto su misura', remise: 'Sconto trasporto su misura', description: 'Quantità : {qty} | Totale m² : {m2} | Tempi di produzione + consegna : circa 21 giorni' },
          en: { product: 'Camouflage net {shape} custom made', transport: 'Custom shipping', remise: 'Custom shipping discount', description: 'Quantity : {qty} | Total m² : {m2} | Production + delivery time : approx. 21 days' },
        };
        const shapeMap: Record<string, Record<string, string>> = {
          es: { rectangulaire: 'rectangular', triangulaire: 'triangular', 'trapézoïdal': 'trapezoidal', carré: 'cuadrada' },
          pt: { rectangulaire: 'retangular', triangulaire: 'triangular', 'trapézoïdal': 'trapezoidal', carré: 'quadrada' },
          de: { rectangulaire: 'rechteckig', triangulaire: 'dreieckig', 'trapézoïdal': 'trapezförmig', carré: 'quadratisch' },
          nl: { rectangulaire: 'rechthoekig', triangulaire: 'driehoekig', 'trapézoïdal': 'trapeziumvormig', carré: 'vierkant' },
          it: { rectangulaire: 'rettangolare', triangulaire: 'triangolare', 'trapézoïdal': 'trapezoidale', carré: 'quadrata' },
          en: { rectangulaire: 'rectangular', triangulaire: 'triangular', 'trapézoïdal': 'trapezoidal', carré: 'square' },
        };
        const map = labelMap[storeLang];
        const shapes = shapeMap[storeLang] || {};
        if (map) {
          for (const line of payload.lines) {
            // Traduire tout label contenant "filet de camouflage" (toute variante)
            if (line.label && /filet de camouflage/i.test(line.label)) {
              // Extraire couleur, dimensions, forme, finition depuis le label français
              const couleur = line.label.match(/couleur\s+(\w+)/i)?.[1] || line.label.match(/,\s*(\w+)\s*,/)?.[1] || '';
              const dims = line.label.match(/(\d+[.,]?\d*\s*x\s*\d+[.,]?\d*\s*m)/i)?.[1] || '';
              const finition = line.label.match(/(?:finition|contour)\s+([\w\s]+?)(?:,|$)/i)?.[1]?.trim() || '';
              // Détecter la forme
              let shapeKey = 'rectangulaire';
              for (const key of Object.keys(shapes)) {
                if (line.label.toLowerCase().includes(key)) { shapeKey = key; break; }
              }
              const translatedShape = shapes[shapeKey] || shapeKey;
              const productName = map.product.replace('{shape}', translatedShape);
              const parts = [productName, couleur, dims, finition].filter(Boolean);
              line.label = parts.join(', ');
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
        const subjectMap: Record<string, { devis: string; filet: string }> = {
          es: { devis: 'Presupuesto', filet: 'red de camuflaje' },
          de: { devis: 'Angebot', filet: 'Tarnnetz' },
          nl: { devis: 'Offerte', filet: 'camouflagenet' },
          it: { devis: 'Preventivo', filet: 'rete mimetica' },
          en: { devis: 'Quote', filet: 'camouflage net' },
        };
        const sMap = subjectMap[storeLang];
        if (sMap && payload.subject) {
          // Remplacer "Devis" et toute variante de "filet de camouflage" dans le sujet
          payload.subject = payload.subject
            .replace(/^Devis/i, sMap.devis)
            .replace(/Presupuesto/i, sMap.devis)
            .replace(/filet[s]?\s+de\s+camouflage\s*(rectangulaires?|triangulaires?|trapézoïdaux?|carrés?|sur mesure|standard)?/gi, sMap.filet);
        }
      }

      // Ajouter les images sélectionnées comme annexes
      const selectedImages = availableImages.filter((img) => img.selected).map(({ data, mediaType, name }) => ({ data, mediaType, name }));
      const finalPayload = {
        ...payload,
        ...(selectedImages.length > 0 ? { appendixImages: selectedImages } : {}),
      };

      console.log('[QuotePanel] final payload:', JSON.stringify({ ...finalPayload, appendixImages: selectedImages.length > 0 ? `[${selectedImages.length} images]` : undefined }, null, 2));

      const response = await fetch(`${API_BASE}/api/plugin/create-quote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(finalPayload),
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
      onQuoteCreated?.(quoteResult.pdfUrl, quoteResult.quoteNumber, quoteResult.pennylaneUrl, totalTTC);
    } catch (err) {
      console.error('[plugin] create-quote error:', err);
      setError(err instanceof Error ? err.message : 'Erreur inconnue');
      setState('verify');
    }
  }
}
