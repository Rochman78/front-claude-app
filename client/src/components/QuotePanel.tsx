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

/** Codes pays UE (27) — FR EXCLU volontairement puisqu'on est boutique française
 * et que la TVA nationale s'applique sur les transactions FR → FR sans besoin
 * de n° intra. */
const EU_COUNTRIES_NON_FR = [
  'AT','BE','BG','CY','CZ','DE','DK','EE','ES','FI','GR','HR','HU',
  'IE','IT','LT','LU','LV','MT','NL','PL','PT','RO','SE','SI','SK',
];

/** Libellés lisibles pour le brouillon "demande n° TVA" */
const COUNTRY_LABEL: Record<string, string> = {
  AT: 'Autriche', BE: 'Belgique', BG: 'Bulgarie', CY: 'Chypre', CZ: 'République tchèque',
  DE: 'Allemagne', DK: 'Danemark', EE: 'Estonie', ES: 'Espagne', FI: 'Finlande',
  GR: 'Grèce', HR: 'Croatie', HU: 'Hongrie', IE: 'Irlande', IT: 'Italie',
  LT: 'Lituanie', LU: 'Luxembourg', LV: 'Lettonie', MT: 'Malte', NL: 'Pays-Bas',
  PL: 'Pologne', PT: 'Portugal', RO: 'Roumanie', SE: 'Suède', SI: 'Slovénie',
  SK: 'Slovaquie',
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
  /** Notifie le parent (PluginMain) des transitions d'état interne
   *  (idle / extracting / verify / creating / done). Utilisé pour
   *  masquer la sticky bar du plugin quand le form devis est actif
   *  (« masque devis PDF » plein écran, cf. Charles 03/07/2026). */
  onStateChange?: (state: 'idle' | 'extracting' | 'verify' | 'creating' | 'done') => void;
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
  // SIRET (14 chiffres) — pour les entreprises françaises. Mappé à
  // registration_number côté Pennylane pour apparaître sur le PDF légal.
  siret: string;
  // Adresse de facturation (envoyée à Pennylane comme billing_address, obligatoire)
  street: string;
  postalCode: string;
  city: string;
  country: string;
  // Adresse de livraison (envoyée à Pennylane comme delivery_address si distincte).
  // Si deliverySameAsBilling=true → on ignore les 4 champs delivery* et on reprend
  // les champs de facturation ci-dessus au moment du push.
  deliverySameAsBilling: boolean;
  deliveryStreet: string;
  deliveryPostalCode: string;
  deliveryCity: string;
  deliveryCountry: string;
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
  claudeText, mailThread, customerEmail, customerName, storeCode, inboxName, frontConversationId, onSendMessage: _onSendMessage, onQuoteCreated, onRegisterClick, onListMessages, onStateChange,
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
  // Lignes que Claude avait extraites (pour bypass si trapèze détecté à tort).
  const [claudeExtractedLines, setClaudeExtractedLines] = useState<Array<{
    label: string;
    quantity: string;
    unitPrice: string;
    unit: string;
    type: string;
    description?: string;
  }> | null>(null);
  // Popup "croquis manquant" bloquant pour les formes non rectangle/carré
  // sans aucune image annexée.
  const [showMissingSketchPopup, setShowMissingSketchPopup] = useState(false);
  const [askSketchStatus, setAskSketchStatus] = useState<'idle' | 'sending' | 'ok' | 'error'>('idle');
  const [askSketchError, setAskSketchError] = useState<string | null>(null);
  // Popup "n° TVA intra manquant" bloquant pour les entreprises UE hors FR
  // sans n° TVA intracommunautaire.
  const [showMissingVatPopup, setShowMissingVatPopup] = useState(false);
  const [askVatStatus, setAskVatStatus] = useState<'idle' | 'sending' | 'ok' | 'error'>('idle');
  const [askVatError, setAskVatError] = useState<string | null>(null);
  // Popup "TVA incohérente" bloquant quand n° TVA intra UE renseigné mais
  // taux TVA saisi ≠ 0 (LIC art. 138 impose 0 %).
  const [showVatShouldBeZeroPopup, setShowVatShouldBeZeroPopup] = useState(false);
  // Warnings serveur (ex: TTC saisi ≠ TTC catalogue, SKU absent, etc.)
  // remontés depuis /api/plugin/extract-quote. Affichés en orange dans le panel.
  const [extractWarnings, setExtractWarnings] = useState<string[]>([]);
  // Erreur d'extraction (call /extract-quote KO, Claude a renvoyé du JSON
  // mal formé, timeout, etc.). Affichée en rouge tout en haut du form avec
  // un bouton Réessayer, au lieu de tomber silencieusement sur un form
  // vide qui laisse le gérant sans info. Cas déclencheur cnv_1lqwbyl3
  // (TAR, 03/07/2026).
  const [extractError, setExtractError] = useState<string | null>(null);

  // Exposer handleClick au parent
  useEffect(() => {
    onRegisterClick?.(handleClick);
  });

  // Notifier le parent des transitions d'état pour qu'il puisse adapter
  // son layout (ex : PluginMain masque la sticky bar quand state=verify
  // pour laisser toute la place au form devis).
  useEffect(() => {
    onStateChange?.(state);
  }, [state, onStateChange]);

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
      setVerifyForm({ ...f, lines: [...f.lines, { label: '', quantity: '1', unitPrice: '0', unit: 'm2', type: 'product', description: '' }] });
    };
    const removeLine = (idx: number) => {
      if (f.lines.length <= 1) return;
      setVerifyForm({ ...f, lines: f.lines.filter((_, i) => i !== idx) });
    };

    const inputStyle = { width: '100%', padding: '4px 6px', fontSize: '12px', border: '1px solid #cbd5e0', borderRadius: '4px', color: '#1a202c', background: '#fff' };
    const labelStyle = { fontSize: '11px', color: '#2d3748', marginBottom: '2px', display: 'block' as const, fontWeight: 500 };
    const sectionTitleStyle = { fontWeight: 700, marginBottom: '8px', fontSize: '13px', color: '#1a202c', letterSpacing: '0.02em' as const };
    const sectionBoxStyle = { marginBottom: '10px', padding: '10px', background: '#f1f5f9', borderRadius: '6px', border: '1px solid #cbd5e0' };
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
              {/* Bypass : si le panel détecte un trapèze à tort (rectangle, triangles
                  + libellé tarifaire "Triangle-Trapèze", mention "trapèze" dans une
                  observation photo, etc.), on permet de restaurer les lignes que
                  Claude avait extraites en un clic. */}
              {claudeExtractedLines && claudeExtractedLines.length > 0 && (
                <button
                  onClick={() => {
                    setShowTrapezePopup(false);
                    setIsTrapeze(false);
                    setVerifyForm(f => (f ? { ...f, lines: claudeExtractedLines } : f));
                  }}
                  style={{
                    width: '100%', padding: '10px 16px', fontSize: '13px', fontWeight: 600,
                    border: '1px solid #cbd5e0', borderRadius: '6px',
                    background: 'white', color: '#2d3748', cursor: 'pointer',
                    marginBottom: '8px',
                  }}
                >
                  Ce n'est pas un trapèze — pré-remplir quand même
                </button>
              )}
              <button
                onClick={() => setShowTrapezePopup(false)}
                style={{
                  width: '100%', padding: '10px 16px', fontSize: '13px', fontWeight: 600,
                  border: 'none', borderRadius: '6px', background: '#e53e3e', color: 'white', cursor: 'pointer',
                }}
              >
                J'ai compris (lignes vides)
              </button>
            </div>
          </div>
        )}

        {/* Popup croquis manquant — bloquant quand on tente de générer le devis
            sur une forme autre que rectangle/carré et sans aucune image annexée.
            3 boutons : demander le croquis au client (brouillon Front), bypass
            avec confirmation, ou annuler. */}
        {showMissingSketchPopup && (
          <div style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2500,
          }}>
            <div style={{
              background: 'white', borderRadius: '12px', padding: '20px', maxWidth: '460px', width: '92%',
              boxShadow: '0 4px 20px rgba(0,0,0,0.2)', color: '#000',
            }}>
              <h3 style={{ margin: '0 0 12px 0', fontSize: '15px', fontWeight: 700, color: '#9b2c2c' }}>
                ⚠ Croquis obligatoire — aucune image annexée
              </h3>
              <p style={{ fontSize: '12.5px', lineHeight: 1.55, marginBottom: '10px' }}>
                Ce devis contient une forme <strong>{detectComplexShape()}</strong> qui ne peut pas être fabriquée
                sans un croquis annoté (cotes, vue de dessus).
              </p>
              <p style={{ fontSize: '12.5px', lineHeight: 1.55, marginBottom: '12px' }}>
                Sélectionne au moins une image dans la section « Annexes » ci-dessus,
                ou choisis l'une des options :
              </p>

              {askSketchStatus === 'ok' ? (
                <div style={{
                  background: '#f0fff4', border: '1px solid #9ae6b4', borderRadius: '6px',
                  padding: '10px', fontSize: '12.5px', color: '#22543d', marginBottom: '10px',
                }}>
                  ✓ Brouillon de demande de croquis posé dans Front. Relis et envoie côté Front App.
                </div>
              ) : askSketchStatus === 'error' ? (
                <div style={{
                  background: '#fff5f5', border: '1px solid #feb2b2', borderRadius: '6px',
                  padding: '10px', fontSize: '12.5px', color: '#742a2a', marginBottom: '10px',
                }}>
                  ✗ Erreur : {askSketchError || 'push brouillon échoué'}
                </div>
              ) : null}

              <button
                onClick={() => handleAskSketchDraft()}
                disabled={askSketchStatus === 'sending' || askSketchStatus === 'ok'}
                style={{
                  width: '100%', padding: '10px 16px', fontSize: '13px', fontWeight: 600,
                  border: 'none', borderRadius: '6px', background: askSketchStatus === 'ok' ? '#a0aec0' : '#3182ce',
                  color: 'white', cursor: askSketchStatus === 'sending' || askSketchStatus === 'ok' ? 'default' : 'pointer',
                  marginBottom: '8px', opacity: askSketchStatus === 'sending' ? 0.7 : 1,
                }}
              >
                {askSketchStatus === 'sending'
                  ? '…envoi du brouillon…'
                  : askSketchStatus === 'ok'
                  ? '✓ Brouillon posé dans Front'
                  : 'Envoyer un mail au client pour demander le croquis'}
              </button>

              <button
                onClick={() => {
                  const ok = window.confirm(
                    'Es-tu sûr ? Aucun croquis annexé au devis PDF. '
                    + "L'atelier n'aura pas la vue de dessus ni les cotes précises pour fabriquer."
                  );
                  if (ok) {
                    setShowMissingSketchPopup(false);
                    handleCreateFromForm(true);
                  }
                }}
                style={{
                  width: '100%', padding: '10px 16px', fontSize: '13px', fontWeight: 600,
                  border: '1px solid #cbd5e0', borderRadius: '6px',
                  background: 'white', color: '#dd6b20', cursor: 'pointer',
                  marginBottom: '8px',
                }}
              >
                Générer sans croquis (à confirmer)
              </button>

              <button
                onClick={() => setShowMissingSketchPopup(false)}
                style={{
                  width: '100%', padding: '8px 16px', fontSize: '12.5px', fontWeight: 500,
                  border: 'none', borderRadius: '6px',
                  background: 'transparent', color: '#4a5568', cursor: 'pointer',
                }}
              >
                Annuler
              </button>
            </div>
          </div>
        )}

        {/* Popup n° TVA intra manquant — bloquant quand on tente de générer le
            devis pour une entreprise UE hors FR sans n° TVA intracommunautaire.
            3 boutons : demander le n° au client (brouillon Front), bypass avec
            confirmation (TVA FR 20 % appliquée par défaut), ou annuler. */}
        {showMissingVatPopup && (
          <div style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2500,
          }}>
            <div style={{
              background: 'white', borderRadius: '12px', padding: '20px', maxWidth: '460px', width: '92%',
              boxShadow: '0 4px 20px rgba(0,0,0,0.2)', color: '#000',
            }}>
              <h3 style={{ margin: '0 0 12px 0', fontSize: '15px', fontWeight: 700, color: '#9b2c2c' }}>
                ⚠ N° de TVA intracommunautaire manquant
              </h3>
              <p style={{ fontSize: '12.5px', lineHeight: 1.55, marginBottom: '10px' }}>
                Client entreprise en <strong>{COUNTRY_LABEL[(verifyForm?.country || '').trim().toUpperCase()] || verifyForm?.country}</strong>{' '}
                sans numéro de TVA intracommunautaire.
              </p>
              <p style={{ fontSize: '12.5px', lineHeight: 1.55, marginBottom: '12px' }}>
                Sans ce numéro, la TVA <strong>française à 20 %</strong> sera appliquée sur le devis
                (impossible de facturer en exonération intracommunautaire). Ajoute le n° de TVA
                dans le champ ci-dessus si tu l'as, ou choisis :
              </p>

              {askVatStatus === 'ok' ? (
                <div style={{
                  background: '#f0fff4', border: '1px solid #9ae6b4', borderRadius: '6px',
                  padding: '10px', fontSize: '12.5px', color: '#22543d', marginBottom: '10px',
                }}>
                  ✓ Brouillon de demande de n° TVA posé dans Front. Relis et envoie côté Front App.
                </div>
              ) : askVatStatus === 'error' ? (
                <div style={{
                  background: '#fff5f5', border: '1px solid #feb2b2', borderRadius: '6px',
                  padding: '10px', fontSize: '12.5px', color: '#742a2a', marginBottom: '10px',
                }}>
                  ✗ Erreur : {askVatError || 'push brouillon échoué'}
                </div>
              ) : null}

              <button
                onClick={() => handleAskVatDraft()}
                disabled={askVatStatus === 'sending' || askVatStatus === 'ok'}
                style={{
                  width: '100%', padding: '10px 16px', fontSize: '13px', fontWeight: 600,
                  border: 'none', borderRadius: '6px', background: askVatStatus === 'ok' ? '#a0aec0' : '#3182ce',
                  color: 'white', cursor: askVatStatus === 'sending' || askVatStatus === 'ok' ? 'default' : 'pointer',
                  marginBottom: '8px', opacity: askVatStatus === 'sending' ? 0.7 : 1,
                }}
              >
                {askVatStatus === 'sending'
                  ? '…envoi du brouillon…'
                  : askVatStatus === 'ok'
                  ? '✓ Brouillon posé dans Front'
                  : 'Envoyer un mail au client pour demander le n° TVA'}
              </button>

              <button
                onClick={() => {
                  const ok = window.confirm(
                    'Es-tu sûr ? Le devis sera généré avec TVA française 20 % '
                    + '(pas de facturation en exonération intracommunautaire).'
                  );
                  if (ok) {
                    setShowMissingVatPopup(false);
                    // On bypass la TVA MAIS on garde le check croquis (déjà passé
                    // avant l'affichage du popup TVA, donc ok). On rappelle avec
                    // (bypassSketch=true, bypassVat=true) pour skip les 2 checks
                    // au retour.
                    handleCreateFromForm(true, true);
                  }
                }}
                style={{
                  width: '100%', padding: '10px 16px', fontSize: '13px', fontWeight: 600,
                  border: '1px solid #cbd5e0', borderRadius: '6px',
                  background: 'white', color: '#dd6b20', cursor: 'pointer',
                  marginBottom: '8px',
                }}
              >
                Générer avec TVA française 20 % (à confirmer)
              </button>

              <button
                onClick={() => setShowMissingVatPopup(false)}
                style={{
                  width: '100%', padding: '8px 16px', fontSize: '12.5px', fontWeight: 500,
                  border: 'none', borderRadius: '6px',
                  background: 'transparent', color: '#4a5568', cursor: 'pointer',
                }}
              >
                Annuler (revenir au formulaire pour saisir le n° TVA)
              </button>
            </div>
          </div>
        )}

        {/* Popup TVA devrait être à 0 % — bloquant quand n° TVA intra UE
            renseigné mais taux TVA saisi ≠ 0. LIC art. 138 : la vente est
            obligatoirement exonérée. Sinon = surfacturation client. */}
        {showVatShouldBeZeroPopup && verifyForm && (() => {
          const countryUpper = (verifyForm.country || '').trim().toUpperCase();
          const paysLabel = COUNTRY_LABEL[countryUpper] || countryUpper;
          const currentVat = parseFloat(verifyForm.vatPercent || '0');
          // Estimation grossière de l'écart (calcul propre côté sub-total)
          const totalHT = verifyForm.lines.reduce((acc, l) => {
            const q = parseFloat(l.quantity.replace(',', '.')) || 0;
            const p = parseFloat(l.unitPrice.replace(',', '.')) || 0;
            return acc + q * p;
          }, 0);
          const ecartTTC = Math.round(totalHT * (currentVat / 100) * 100) / 100;
          return (
            <div style={{
              position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
              background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2500,
            }}>
              <div style={{
                background: 'white', borderRadius: '12px', padding: '20px', maxWidth: '480px', width: '92%',
                boxShadow: '0 4px 20px rgba(0,0,0,0.2)', color: '#000',
              }}>
                <h3 style={{ margin: '0 0 12px 0', fontSize: '15px', fontWeight: 700, color: '#9b2c2c' }}>
                  ⚠ TVA incohérente — devrait être à 0 %
                </h3>
                <p style={{ fontSize: '12.5px', lineHeight: 1.55, marginBottom: '10px' }}>
                  Client entreprise en <strong>{paysLabel}</strong> avec n° TVA intracommunautaire{' '}
                  <code style={{ background: '#f7fafc', padding: '1px 4px', borderRadius: 3 }}>{verifyForm.vatNumber}</code>{' '}
                  renseigné.
                </p>
                <p style={{ fontSize: '12.5px', lineHeight: 1.55, marginBottom: '10px' }}>
                  Dans ce cas, la loi impose <strong>TVA à 0 %</strong> (livraison intracommunautaire — art. 138 Directive 2006/112/CE). Or le taux saisi est <strong>{currentVat} %</strong>.
                </p>
                {ecartTTC > 0 && (
                  <p style={{ fontSize: '12.5px', lineHeight: 1.55, marginBottom: '10px', color: '#c05621', fontWeight: 600 }}>
                    Écart potentiel : ~{ecartTTC.toFixed(2)} € de TVA en trop sur le devis.
                  </p>
                )}
                <p style={{ fontSize: '12.5px', lineHeight: 1.55, marginBottom: '14px', color: '#742a2a' }}>
                  ⚠ Avant de continuer : <strong>vérifie l'historique mail</strong> — le client a peut-être vu un TTC annoncé avec cette TVA nationale. Le vrai TTC en LIC sera différent, il faudra peut-être re-communiquer.
                </p>

                <button
                  onClick={() => {
                    setVerifyForm({ ...verifyForm, vatPercent: '0' });
                    setShowVatShouldBeZeroPopup(false);
                  }}
                  style={{
                    width: '100%', padding: '10px 16px', fontSize: '13px', fontWeight: 600,
                    border: 'none', borderRadius: '6px', background: '#38a169', color: 'white', cursor: 'pointer',
                    marginBottom: '8px',
                  }}
                >
                  Corriger : passer la TVA à 0 % (LIC)
                </button>

                <button
                  onClick={() => {
                    const ok = window.confirm(
                      `Es-tu sûr ? Le devis partira avec TVA ${currentVat} % au lieu de 0 %. `
                      + "Vérifie que le client n'a pas déjà vu un montant TTC annoncé — sinon le vrai TTC en LIC sera différent."
                    );
                    if (ok) {
                      setShowVatShouldBeZeroPopup(false);
                      handleCreateFromForm(true, true, true);
                    }
                  }}
                  style={{
                    width: '100%', padding: '10px 16px', fontSize: '13px', fontWeight: 600,
                    border: '1px solid #cbd5e0', borderRadius: '6px',
                    background: 'white', color: '#dd6b20', cursor: 'pointer',
                    marginBottom: '8px',
                  }}
                >
                  Générer quand même avec TVA {currentVat} % (à confirmer)
                </button>

                <button
                  onClick={() => setShowVatShouldBeZeroPopup(false)}
                  style={{
                    width: '100%', padding: '8px 16px', fontSize: '12.5px', fontWeight: 500,
                    border: 'none', borderRadius: '6px',
                    background: 'transparent', color: '#4a5568', cursor: 'pointer',
                  }}
                >
                  Annuler (revenir au formulaire)
                </button>
              </div>
            </div>
          );
        })()}

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
        <div style={sectionBoxStyle}>
          <div style={sectionTitleStyle}>Client</div>
          <div style={rowStyle}>
            <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: '4px' }}>
              <input type="radio" checked={f.clientType === 'individual'} onChange={() => upd('clientType', 'individual')} /> Particulier
            </label>
            <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: '4px' }}>
              <input type="radio" checked={f.clientType === 'company'} onChange={() => upd('clientType', 'company')} /> Entreprise
            </label>
          </div>
          {f.clientType === 'company' && (() => {
            // Le n° TVA intra est obligatoire pour une livraison en UE hors
            // France (régime LIC, TVA 0 %). Il N'EST PAS applicable pour :
            //  - FR (TVA 20 % locale)
            //  - Hors UE (Andorre AD, Suisse CH, GB, hors UE→0 % export
            //    sans besoin de TVA intra)
            // Cas déclencheur cnv_1lqbn1w7 (03/07/2026) : Natur Hotels SL
            // AD (Andorre) → le form obligeait le n° TVA intra à tort.
            // Fix : n'exiger le n° QUE quand pays ∈ UE (hors FR).
            const countryUpper = (f.country || '').trim().toUpperCase();
            const vatPercentNum = parseFloat(f.vatPercent || '0');
            const vatNumberRequired =
              vatPercentNum === 0 && EU_COUNTRIES_NON_FR.includes(countryUpper);
            const vatNumberEmpty = !f.vatNumber.trim();
            const vatNumberError = vatNumberRequired && vatNumberEmpty;
            const vatLabelStyle = vatNumberError
              ? { ...labelStyle, color: '#e53e3e', fontWeight: 600 }
              : labelStyle;
            const vatInputStyle = vatNumberError
              ? { ...inputStyle, border: '1.5px solid #e53e3e', background: '#fff5f5' }
              : inputStyle;
            return (
              <div style={rowStyle}>
                <div style={{ flex: 1 }}><span style={labelStyle}>Raison sociale</span><input style={inputStyle} value={f.companyName} onChange={(e) => upd('companyName', e.target.value)} /></div>
                <div style={{ flex: 1 }}>
                  <span style={vatLabelStyle}>N° TVA intra{vatNumberRequired ? ' *' : ''}</span>
                  <input
                    style={vatInputStyle}
                    value={f.vatNumber}
                    placeholder={vatNumberRequired ? 'Obligatoire (ex : IT12345678901)' : ''}
                    onChange={(e) => {
                      const val = e.target.value;
                      upd('vatNumber', val);
                      // Si n° TVA intra renseigné et pays UE hors France → TVA 0 % (LIC)
                      const countryFromVat = val.replace(/[^A-Z]/g, '').substring(0, 2);
                      const countryFromForm = f.country?.toUpperCase() || '';
                      const country = countryFromVat || countryFromForm;
                      if (val.trim().length >= 4 && EU_COUNTRIES_NON_FR.includes(country)) {
                        upd('vatPercent', '0');
                      }
                    }}
                  />
                </div>
              </div>
            );
          })()}
          {f.clientType === 'company' && (
            <div style={rowStyle}>
              <div style={{ flex: 1 }}>
                <span style={labelStyle}>N° SIRET</span>
                <input
                  style={inputStyle}
                  value={f.siret}
                  placeholder="14 chiffres (ex : 21310555400012)"
                  onChange={(e) => upd('siret', e.target.value)}
                />
              </div>
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

        {/* Adresse de facturation */}
        <div style={sectionBoxStyle}>
          <div style={sectionTitleStyle}>Adresse de facturation</div>
          <div style={rowStyle}>
            <div style={{ flex: 1 }}><span style={labelStyle}>Rue</span><input style={inputStyle} value={f.street} onChange={(e) => upd('street', e.target.value)} /></div>
          </div>
          <div style={rowStyle}>
            <div style={{ flex: 1 }}><span style={labelStyle}>Code postal</span><input style={inputStyle} value={f.postalCode} onChange={(e) => upd('postalCode', e.target.value)} /></div>
            <div style={{ flex: 1 }}><span style={labelStyle}>Ville</span><input style={inputStyle} value={f.city} onChange={(e) => upd('city', e.target.value)} /></div>
            <div style={{ flex: 1 }}><span style={labelStyle}>Pays</span><input style={inputStyle} value={f.country} onChange={(e) => upd('country', e.target.value)} /></div>
          </div>
        </div>

        {/* Adresse de livraison — cachée si "identique à la facturation"
            (cas 90 %). Décochée → 4 champs éditables. Pré-remplie depuis
            customer.deliveryAddress si extract-quote a trouvé une adresse de
            livraison distincte dans le fil de mails. */}
        <div style={sectionBoxStyle}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
            <div style={sectionTitleStyle}>Adresse de livraison</div>
            <label style={{ fontSize: '11px', color: '#2d3748', display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={f.deliverySameAsBilling}
                onChange={(e) => upd('deliverySameAsBilling', e.target.checked)}
              />
              Identique à la facturation
            </label>
          </div>
          {!f.deliverySameAsBilling && (
            <>
              <div style={rowStyle}>
                <div style={{ flex: 1 }}><span style={labelStyle}>Rue</span><input style={inputStyle} value={f.deliveryStreet} onChange={(e) => upd('deliveryStreet', e.target.value)} /></div>
              </div>
              <div style={rowStyle}>
                <div style={{ flex: 1 }}><span style={labelStyle}>Code postal</span><input style={inputStyle} value={f.deliveryPostalCode} onChange={(e) => upd('deliveryPostalCode', e.target.value)} /></div>
                <div style={{ flex: 1 }}><span style={labelStyle}>Ville</span><input style={inputStyle} value={f.deliveryCity} onChange={(e) => upd('deliveryCity', e.target.value)} /></div>
                <div style={{ flex: 1 }}><span style={labelStyle}>Pays</span><input style={inputStyle} value={f.deliveryCountry} onChange={(e) => upd('deliveryCountry', e.target.value)} /></div>
              </div>
            </>
          )}
        </div>

        {/* Erreur d'extraction (Claude a tout raté OU répondu vide). Rouge
            + bouton Réessayer pour relancer handleClick. */}
        {extractError && (
          <div style={{
            background: '#fef2f2', border: '1px solid #fc8181', borderRadius: '6px',
            padding: '10px 12px', margin: '6px 0 10px 0', fontSize: '12px', color: '#7a1f1f',
          }}>
            <div style={{ fontWeight: 700, marginBottom: '6px' }}>⚠ Extraction incomplète</div>
            <div style={{ marginBottom: '8px', lineHeight: 1.4 }}>{extractError}</div>
            <button
              onClick={() => { setExtractError(null); handleClick(); }}
              style={{
                padding: '6px 12px', background: '#c53030', color: 'white', border: 'none',
                borderRadius: '4px', fontSize: '11px', fontWeight: 600, cursor: 'pointer',
              }}
            >
              🔄 Réessayer l'extraction
            </button>
          </div>
        )}

        {/* Warnings serveur (cohérence catalogue SKU / TTC) — affichés au-dessus
            des lignes produit, en orange (non bloquant, l'utilisateur peut
            corriger à la main ou valider). */}
        {extractWarnings.length > 0 && (
          <div style={{
            background: '#fffbeb', border: '1px solid #f6ad55', borderRadius: '6px',
            padding: '8px 10px', margin: '6px 0 10px 0', fontSize: '11.5px', color: '#7b341e',
          }}>
            <div style={{ fontWeight: 600, marginBottom: '4px' }}>
              ⚠ {extractWarnings.length} avertissement{extractWarnings.length > 1 ? 's' : ''} de cohérence catalogue :
            </div>
            <ul style={{ margin: 0, paddingLeft: '18px', lineHeight: 1.4 }}>
              {extractWarnings.map((w, i) => (
                <li key={i} style={{ marginBottom: i < extractWarnings.length - 1 ? '4px' : 0 }}>{w}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Produits */}
        <div style={sectionBoxStyle}>
          <div style={sectionTitleStyle}>Produits</div>
          {f.lines.map((line, idx) => {
            const lineType = String(line.type || '').toLowerCase();
            const isTransport = lineType === 'transport' || lineType === 'transport_discount';
            // Description visible pour les produits (SKU pour standards,
            // "Quantité : X | Total m² : Y | Délai..." pour sur-mesure).
            // Cachée pour les lignes transport / remise transport qui n'en
            // ont pas besoin dans le PDF Pennylane.
            const showDescription = !isTransport;
            return (
              <div key={idx} style={{ marginBottom: '10px', paddingBottom: '10px', borderBottom: idx < f.lines.length - 1 ? '1px dashed #ddd' : 'none' }}>
                {/* Produit : label découpé en cellules sur " — " (em-dash
                    séparateur standard des labels sur-mesure : « Filet de
                    camouflage rectangulaire sur-mesure — sable — câble acier
                    inox Ø 3 mm » → 3 cellules typologie / couleur / finition).
                    Pour les labels sans em-dash (accessoires, standards), le
                    label reste en une seule cellule. Édition par cellule,
                    réassemblage avec " — " en sortie. */}
                {(() => {
                  const rawLabel = line.label || '';
                  const parts = rawLabel.length > 0 ? rawLabel.split(' — ') : [''];
                  const updatePart = (partIdx: number, val: string) => {
                    const next = [...parts];
                    next[partIdx] = val;
                    updLine(idx, 'label', next.filter((s) => s.trim().length > 0).join(' — '));
                  };
                  const partStyle = {
                    flex: 1,
                    minWidth: '110px',
                    padding: '4px 6px',
                    fontSize: '12px',
                    color: '#1a202c',
                    background: '#fff',
                    border: '1px solid #cbd5e0',
                    borderRadius: '4px',
                    fontWeight: 500 as const,
                  };
                  return (
                    <div style={{ marginBottom: '6px' }}>
                      <span style={labelStyle}>Produit</span>
                      <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                        {parts.map((part, partIdx) => (
                          <input
                            key={partIdx}
                            style={partStyle}
                            value={part}
                            onChange={(e) => updatePart(partIdx, e.target.value)}
                          />
                        ))}
                      </div>
                    </div>
                  );
                })()}
                <div style={{ ...rowStyle, alignItems: 'flex-end', marginBottom: showDescription ? '4px' : '0' }}>
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
                    <button onClick={() => removeLine(idx)} style={{ border: 'none', background: 'none', color: '#e53e3e', cursor: 'pointer', fontSize: '16px', padding: '0 4px', alignSelf: 'flex-end' }}>×</button>
                  )}
                </div>
                {showDescription && (
                  // Description : 1 SEULE cellule éditable (revient au format
                  // demandé par Charles 02/07/2026, PR #171 split en cellules
                  // reverté sur PR de ce commit). Style italique + jaune pâle
                  // pour dissociation visuelle du bloc produit au-dessus.
                  <div style={{ marginTop: '4px' }}>
                    <span style={{ ...labelStyle, fontSize: '10px', color: '#718096', fontWeight: 400, fontStyle: 'italic' as const }}>
                      Description (visible sous le produit dans le PDF)
                    </span>
                    <input
                      style={{
                        width: '100%',
                        padding: '4px 6px',
                        fontSize: '11px',
                        fontStyle: 'italic',
                        color: '#4a5568',
                        background: '#fefce8',
                        border: '1px solid #eab308',
                        borderRadius: '4px',
                      }}
                      value={line.description || ''}
                      onChange={(e) => updLine(idx, 'description', e.target.value)}
                      placeholder={line.unit === 'piece' ? 'SKU : xxxxxxxxxxxxx' : 'Quantité : X | Total m² : Y | Délai de production + livraison : environ 21 jours'}
                    />
                  </div>
                )}
              </div>
            );
          })}
          <button onClick={addLine} style={{ fontSize: '11px', color: '#4a90d9', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0' }}>
            + Ajouter un produit
          </button>
        </div>

        {/* TVA + Livraison */}
        <div style={sectionBoxStyle}>
          <div style={rowStyle}>
            <div style={{ flex: 1 }}><span style={labelStyle}>TVA (%)</span><input style={inputStyle} value={f.vatPercent} onChange={(e) => upd('vatPercent', e.target.value)} /></div>
            <div style={{ flex: 1 }}><span style={labelStyle}>Remise (%)</span><input style={inputStyle} value={f.discountPercent} onChange={(e) => upd('discountPercent', e.target.value)} /></div>
          </div>
        </div>

        {/* Annexes images */}
        {availableImages.length > 0 && (
          <div style={sectionBoxStyle}>
            <div style={sectionTitleStyle}>Annexes (joindre au devis PDF)</div>
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
              {/* Bloc totaux — l'écart avec expectedTTC (TTC du dernier
                  chiffrage envoyé au client par mail) est baked in la ligne
                  Total TTC elle-même : gras + vert si écart 0, gras + rouge
                  si écart > 0,01 € avec le montant de l'écart affiché.
                  Rendu voulu par Charles (02/07/2026) — plus de bandeau
                  séparé "✓ TTC cohérent". */}
              <div style={{
                marginBottom: '10px',
                padding: '10px',
                background: ttcMismatch ? '#fef2f2' : '#e6fffa',
                borderRadius: '6px',
                fontSize: '13px',
                color: '#1a202c',
                border: ttcMismatch ? '1px solid #fc8181' : '1px solid #4fd1c5',
              }}>
                <div>Total HT brut : <strong>{totalHTBrut.toFixed(2)} €</strong></div>
                {/* Ligne Remise toujours affichée (même à 0 %) — demande
                    Charles 02/07/2026 : garder les 5 lignes constantes pour
                    lecture rapide, éviter le saut visuel selon présence
                    d'une remise. */}
                <div>Remise ({discount}%) : <strong>{discount > 0 ? `-${discountAmount.toFixed(2)}` : '0.00'} €</strong></div>
                <div>Total HT après remise : <strong>{totalHT.toFixed(2)} €</strong></div>
                <div>TVA ({vat}%) : <strong>{r2(totalHT * vat / 100).toFixed(2)} €</strong></div>
                {(() => {
                  // Ligne Total TTC : gras + vert (écart 0) OU gras + rouge
                  // (écart X €) selon comparaison avec expectedTTC (TTC du
                  // dernier chiffrage envoyé au client par mail).
                  // Sans expectedTTC (pas de mail précédent référencé), on
                  // reste sur un rendu neutre.
                  if (expectedTTC === null) {
                    return <div>Total TTC : <strong>{totalTTC.toFixed(2)} €</strong></div>;
                  }
                  const ecart = Math.abs(totalTTC - expectedTTC);
                  const isAligned = ecart <= 0.01;
                  const color = isAligned ? '#22543d' : '#c53030';
                  const ecartStr = isAligned ? '0 €' : `${ecart.toFixed(2)} €`;
                  return (
                    <div style={{ color, fontWeight: 700 }}>
                      Total TTC : {totalTTC.toFixed(2)} € — écart {ecartStr}
                    </div>
                  );
                })()}
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
          // N° TVA intra manquant : signalé en amont pour info uniquement.
          // Le blocage effectif se fait au moment du clic "Générer le devis"
          // via un popup (permet le bypass avec confirmation).
          const countryUpper = (f.country || '').trim().toUpperCase();
          const isEuNonFrCompany =
            f.clientType === 'company' &&
            EU_COUNTRIES_NON_FR.includes(countryUpper);
          const vatNumberMissing = isEuNonFrCompany && !f.vatNumber.trim();
          if (vatNumberMissing) missing.push('N° TVA intra');

          // Le bouton reste actif même si n° TVA manquant — le clic déclenche
          // le popup qui offre le bypass. Seul le téléphone bloque encore le
          // bouton (obligatoire côté Pennylane pour émettre le devis).
          const canGenerate = hasPhone;
          const hasMissing = missing.length > 0;

          return (
            <>
              {!hasPhone && (
                <p style={{ color: '#e53e3e', fontSize: '12px', marginBottom: '8px', fontWeight: 600 }}>
                  Numéro de téléphone manquant — obligatoire pour générer le devis.
                </p>
              )}
              {vatNumberMissing && (
                <p style={{ color: '#dd6b20', fontSize: '12px', marginBottom: '8px', fontWeight: 600 }}>
                  ⚠ N° de TVA intracommunautaire manquant — sans ce numéro, TVA française 20 % appliquée par défaut. Le clic sur « Générer le devis » ouvrira un popup avec l'option d'envoyer un mail au client pour demander son n° TVA.
                </p>
              )}
              {hasMissing && canGenerate && (
                <p style={{ color: '#dd6b20', fontSize: '12px', marginBottom: '8px' }}>
                  Champs manquants : {missing.join(', ')}
                </p>
              )}
              <div className="quote-panel-actions">
                <button className="btn-secondary" onClick={() => { setState('idle'); setError(null); }}>Annuler</button>
                <button
                  className="btn-quote"
                  onClick={() => handleCreateFromForm()}
                  disabled={!canGenerate}
                  style={{
                    width: '100%',
                    padding: '14px 16px',
                    fontSize: '15px',
                    fontWeight: 700,
                    letterSpacing: '0.02em',
                    boxShadow: canGenerate ? '0 3px 10px rgba(46, 162, 103, 0.4)' : 'none',
                    opacity: canGenerate ? 1 : 0.5,
                  }}
                >
                  📄 Créer devis PDF dans Pennylane
                </button>
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

    // Détection trapèze : on cherche le mot uniquement dans la (ou les) section(s)
    // BROUILLON de la réponse Claude (= ce qui partira au client), JAMAIS dans
    // les sections ÉTAPE / QUESTIONS / classification interne. Sinon on déclenche
    // sur des analyses comparatives type « ce pourrait être un trapèze ou un
    // quadrilatère » alors que le devis final chiffre un rectangle.
    //
    // Faux positifs catchés par cette logique :
    //   1. « TRIANGLE-TRAPÈZE / ACIER » (libellé tarifaire de prix-ht-sur-mesure.txt)
    //      — cnv_1lpzowt3 (LFC, 24/06/2026)
    //   2. « la zone est un trapèze ou un quadrilatère » écrit en ÉTAPE/QUESTIONS
    //      par Claude qui décrit une photo client — cnv_1lpat1zr (RED, 26/06/2026)
    //
    // Regex large multi-langue conservée pour les vrais cas : trapèze /
    // trapézoïdal (FR), trapezoid/trapezium (EN), trapezio (IT), trapézio (PT),
    // trapezförmig (DE), trapeziumvormig (NL), trapecio (ES).
    const broulionRe = /BROUILLON\b([\s\S]*?)(?=\n---|\nQUESTIONS\b|\nMAIL FINAL\b|$)/gi;
    const broulionSections = [...(claudeText || '').matchAll(broulionRe)].map(m => m[0]).join('\n');
    // Si on ne trouve aucune section BROUILLON (vieux format ou flux atypique),
    // fallback sur le texte complet pour ne pas désactiver la détection.
    const sourceForTrapeze = broulionSections || (claudeText || '');
    // Strip le libellé tarifaire "Triangle-Trapèze" / "Triangle/Trapèze" /
    // "Triangle Trapèze" avant test, pour ne pas matcher dessus.
    const cleanedText = sourceForTrapeze.replace(/triangle[-\s/]+trap[eéè]?[zc][a-zé]*/gi, '');
    const trapezeDetected = /\btrap[eéè]?[zc]/i.test(cleanedText);
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
      setExtractError(null);
      if (response.ok) {
        parsed = await response.json();
        console.log('[QuotePanel] extract-quote result:', parsed);
        // Récupérer les warnings serveur (cohérence catalogue SKU / TTC)
        const w = (parsed?.warnings as string[] | undefined) || [];
        setExtractWarnings(w);
        if (w.length > 0) {
          console.warn('[QuotePanel] extract-quote warnings:', w);
        }
        // Sonnet peut renvoyer un objet quasi vide sur des convs multilingues
        // avec citations imbriquées (cas cnv_1lqwbyl3). On détecte l'échec
        // silencieux : ni customer utile, ni ligne produit → prévient le
        // gérant qu'il peut soit remplir à la main, soit réessayer.
        const linesParsed = (parsed?.lines as Record<string, unknown>[] | undefined) || [];
        const customerParsed = parsed?.customer as Record<string, unknown> | undefined;
        const usefulCustomer = !!(customerParsed && (customerParsed.firstName || customerParsed.lastName || customerParsed.companyName));
        const usefulLines = linesParsed.some((l) => String(l?.label || '').trim().length > 0);
        if (!usefulCustomer && !usefulLines) {
          console.warn('[QuotePanel] extract-quote returned empty structured data');
          setExtractError('Extraction incomplète : Claude n\'a pas pu extraire de données utilisables du fil de mails (contexte multilingue ou complexe). Complète à la main, ou clique Réessayer.');
        }
      } else {
        const err = await response.json().catch(() => ({ error: 'Erreur extraction' }));
        console.warn('[QuotePanel] extract-quote failed:', err);
        setExtractWarnings([]);
        setExtractError(`Extraction échouée : ${err.error || 'erreur serveur'}. Complète à la main, ou clique Réessayer.`);
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

      // Backup des lignes Claude pour permettre un bypass si le popup "Trapèze
      // détecté" est un faux positif (cf bouton « Ce n'est pas un trapèze »
      // dans le popup).
      const backupLines = displayLines.length > 0
        ? displayLines.map(l => ({
            label: String(l.label || ''),
            quantity: String(l.quantity || '1'),
            unitPrice: String(l.unitPrice || '0'),
            unit: String(l.unit || 'm2'),
            type: String(l.type || 'product'),
            description: l.description ? String(l.description) : undefined,
          }))
        : null;
      setClaudeExtractedLines(backupLines);

      // Adresses : nouveau schéma customer.billingAddress + customer.deliveryAddress
      // (rétrocompat serveur : customer.address → customer.billingAddress).
      const billing = (customer?.billingAddress || customer?.address || {}) as Record<string, unknown>;
      const delivery = customer?.deliveryAddress as Record<string, unknown> | null | undefined;
      const hasDeliveryDistinct = !!delivery && (
        String(delivery.address || '').trim().length > 0 ||
        String(delivery.postalCode || '').trim().length > 0 ||
        String(delivery.city || '').trim().length > 0
      );
      setVerifyForm({
        clientType: (customer?.type === 'company' ? 'company' : 'individual'),
        firstName: String(customer?.firstName || ''),
        lastName: String(customer?.lastName || ''),
        companyName: String(customer?.companyName || customer?.name || ''),
        email: String(customer?.email || customerEmail || ''),
        phone: String(customer?.phone || ''),
        vatNumber: String(customer?.vatNumber || ''),
        siret: String(customer?.siret || ''),
        street: String(billing.address || ''),
        postalCode: String(billing.postalCode || ''),
        city: String(billing.city || ''),
        country: String(billing.country || ''),
        deliverySameAsBilling: !hasDeliveryDistinct,
        deliveryStreet: hasDeliveryDistinct ? String(delivery!.address || '') : '',
        deliveryPostalCode: hasDeliveryDistinct ? String(delivery!.postalCode || '') : '',
        deliveryCity: hasDeliveryDistinct ? String(delivery!.city || '') : '',
        deliveryCountry: hasDeliveryDistinct ? String(delivery!.country || '') : '',
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
        siret: '',
        street: '',
        postalCode: '',
        city: '',
        country: '',
        deliverySameAsBilling: true,
        deliveryStreet: '',
        deliveryPostalCode: '',
        deliveryCity: '',
        deliveryCountry: '',
        lines: [{ label: '', quantity: '1', unitPrice: '0', unit: 'm2', type: 'product' }],
        vatPercent: '20',
        discountPercent: '0',
        freeShipping: false,
        subject: 'Devis',
      });
      setState('verify');
    }
  }

  // Pousse un brouillon "demande de croquis" dans Front App. Texte rédigé en
  // français, traduit vers la langue de la boutique au moment du push via
  // /api/plugin/translate (même flow que le brouillon devis principal).
  async function handleAskSketchDraft() {
    if (!frontConversationId) {
      setAskSketchStatus('error');
      setAskSketchError('frontConversationId manquant');
      return;
    }
    setAskSketchStatus('sending');
    setAskSketchError(null);
    try {
      const prenom = verifyForm?.firstName?.trim() || '';
      const forme = detectComplexShape() || 'forme complexe';
      const bodyFr = [
        `Bonjour${prenom ? ' ' + prenom : ''},`,
        '',
        `Merci pour votre demande. Pour vous établir un chiffrage précis sur la forme demandée (${forme}), nous aurions besoin d'un croquis à main levée de votre zone, avec :`,
        '',
        '- Les cotes exactes de chaque côté (au dixième de mètre près)',
        '- Une vue de dessus de la zone à couvrir',
        '',
        'Une simple photo prise au smartphone d\'un croquis papier suffit.',
        '',
        'Dès réception, nous vous transmettons le chiffrage complet.',
      ].join('\n');

      // Traduire si boutique non-FR (même logique que DraftFinal)
      const storeLang = STORE_LANG[storeCode] || 'fr';
      let bodyFinal = bodyFr;
      if (storeLang !== 'fr') {
        try {
          const tr = await fetch(`${API_BASE}/api/plugin/translate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: bodyFr, targetLanguage: storeLang, mailContent: '' }),
          });
          if (tr.ok) {
            const j = await tr.json();
            if (j.translatedText) bodyFinal = j.translatedText;
          }
        } catch (e) {
          console.warn('[QuotePanel] traduction demande croquis échouée, envoi FR :', e);
        }
      }

      // Convertir en HTML simple (paragraphes séparés par des sauts de ligne)
      const html = bodyFinal
        .split('\n')
        .map((l) => (l.trim() ? `<p>${l.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>` : '<p>&nbsp;</p>'))
        .join('');

      const res = await fetch(`${API_BASE}/api/plugin/push-draft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: frontConversationId, body: html }),
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(t.substring(0, 200) || `push-draft ${res.status}`);
      }
      console.log('[QuotePanel] demande de croquis pushée dans Front');
      setAskSketchStatus('ok');
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'erreur inconnue';
      console.error('[QuotePanel] handleAskSketchDraft error:', msg);
      setAskSketchStatus('error');
      setAskSketchError(msg);
    }
  }

  // Pousse un brouillon "demande n° TVA intra" dans Front App. Même flow que
  // handleAskSketchDraft (traduction auto + push-draft).
  async function handleAskVatDraft() {
    if (!frontConversationId) {
      setAskVatStatus('error');
      setAskVatError('frontConversationId manquant');
      return;
    }
    setAskVatStatus('sending');
    setAskVatError(null);
    try {
      const prenom = verifyForm?.firstName?.trim() || '';
      const countryCode = (verifyForm?.country || '').trim().toUpperCase();
      const paysLabel = COUNTRY_LABEL[countryCode] || countryCode;
      const bodyFr = [
        `Bonjour${prenom ? ' ' + prenom : ''},`,
        '',
        `Merci pour votre demande. Vous étant une entreprise située en ${paysLabel}, nous pourrions vous émettre le devis en exonération de TVA intracommunautaire (art. 138 Directive 2006/112/CE). Pour cela, pourriez-vous nous transmettre votre numéro de TVA intracommunautaire ?`,
        '',
        'Format attendu : code pays + chiffres (ex : ES1234567890, DE123456789, IT12345678901).',
        '',
        'Sans ce numéro, nous serons contraints d\'appliquer la TVA française à 20 % sur le devis.',
      ].join('\n');

      const storeLang = STORE_LANG[storeCode] || 'fr';
      let bodyFinal = bodyFr;
      if (storeLang !== 'fr') {
        try {
          const tr = await fetch(`${API_BASE}/api/plugin/translate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: bodyFr, targetLanguage: storeLang, mailContent: '' }),
          });
          if (tr.ok) {
            const j = await tr.json();
            if (j.translatedText) bodyFinal = j.translatedText;
          }
        } catch (e) {
          console.warn('[QuotePanel] traduction demande n° TVA échouée, envoi FR :', e);
        }
      }

      const html = bodyFinal
        .split('\n')
        .map((l) => (l.trim() ? `<p>${l.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>` : '<p>&nbsp;</p>'))
        .join('');

      const res = await fetch(`${API_BASE}/api/plugin/push-draft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: frontConversationId, body: html }),
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(t.substring(0, 200) || `push-draft ${res.status}`);
      }
      console.log('[QuotePanel] demande de n° TVA pushée dans Front');
      setAskVatStatus('ok');
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'erreur inconnue';
      console.error('[QuotePanel] handleAskVatDraft error:', msg);
      setAskVatStatus('error');
      setAskVatError(msg);
    }
  }

  // Détecte si une forme "complexe" (non rectangle et non carré) est présente
  // dans les lignes produit → un croquis annexe devient obligatoire. Sinon
  // impossible pour l'atelier de fabriquer sans ambiguïté.
  function detectComplexShape(): string | null {
    if (!verifyForm) return null;
    for (const l of verifyForm.lines) {
      const t = `${l.label} ${l.description || ''}`.toLowerCase();
      if (/\btriang/.test(t)) return 'triangle';
      if (/\btrap[eéè]?[zc]/.test(t) && !/triangle[-\s/]+trap/.test(t)) return 'trapèze';
      if (/\bquadrilat[eè]re/.test(t)) return 'quadrilatère';
      if (/\bsur[-\s]?mesure\b/.test(t) && !/rectangul/.test(t) && !/\bcarr[éeè]/.test(t)) {
        // sur-mesure mentionné sans forme explicite → on demande le croquis par prudence
        return 'sur-mesure';
      }
    }
    return null;
  }

  async function handleCreateFromForm(bypassSketchCheck = false, bypassVatCheck = false, bypassVatShouldBeZeroCheck = false) {
    if (!verifyForm) return;

    // Garde-fou croquis obligatoire pour formes non rectangle/carré (sauf bypass)
    if (!bypassSketchCheck) {
      const complexShape = detectComplexShape();
      const hasAnyAppendix = availableImages.some((img) => img.selected);
      if (complexShape && !hasAnyAppendix) {
        console.log(`[QuotePanel] Forme complexe détectée (${complexShape}) sans annexe → popup croquis manquant`);
        setShowMissingSketchPopup(true);
        setAskSketchStatus('idle');
        setAskSketchError(null);
        return;
      }
    }

    // Garde-fou n° TVA intra pour entreprise UE hors FR (sauf bypass)
    if (!bypassVatCheck) {
      const countryUpper = (verifyForm.country || '').trim().toUpperCase();
      const isEuNonFrCompany =
        verifyForm.clientType === 'company' &&
        EU_COUNTRIES_NON_FR.includes(countryUpper);
      const vatMissing = isEuNonFrCompany && !verifyForm.vatNumber.trim();
      if (vatMissing) {
        console.log(`[QuotePanel] Entreprise UE (${countryUpper}) sans n° TVA intra → popup n° TVA manquant`);
        setShowMissingVatPopup(true);
        setAskVatStatus('idle');
        setAskVatError(null);
        return;
      }
    }

    // Garde-fou TVA=0 obligatoire quand n° TVA intra UE renseigné (LIC
    // art. 138 Directive 2006/112/CE). Sinon le client reçoit un devis
    // avec TVA nationale, alors qu'il aurait dû être exonéré → risque de
    // surfacturation vs ce qui a été annoncé dans les précédents mails.
    if (!bypassVatShouldBeZeroCheck) {
      const countryUpper = (verifyForm.country || '').trim().toUpperCase();
      const isEuNonFr = EU_COUNTRIES_NON_FR.includes(countryUpper);
      const hasVatNumber = !!verifyForm.vatNumber.trim();
      const vatPercent = parseFloat(verifyForm.vatPercent || '0');
      if (isEuNonFr && hasVatNumber && vatPercent !== 0) {
        console.log(`[QuotePanel] n° TVA intra ${verifyForm.vatNumber} + pays ${countryUpper} + TVA ${vatPercent}% → popup TVA devrait être 0`);
        setShowVatShouldBeZeroPopup(true);
        return;
      }
    }

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
          // Filtre "unit=piece → pas de description" retiré le 02/07/2026 :
          // depuis PR #167, la description des STANDARDS contient le SKU
          // ("SKU : 3770030527439") qui doit apparaître sous le libellé du
          // produit dans le PDF Pennylane (cohérence visuelle avec la ligne
          // description des sur-mesure, demande Charles).
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

      // Résoudre l'adresse de livraison finale : soit distincte, soit copie
      // de la facturation. On envoie TOUJOURS une deliveryAddress à Pennylane
      // (identique à billing si pas distincte) pour que le champ "delivery"
      // apparaisse sur le PDF.
      const deliveryDistinct = !f.deliverySameAsBilling && (
        f.deliveryStreet.trim().length > 0 ||
        f.deliveryPostalCode.trim().length > 0 ||
        f.deliveryCity.trim().length > 0
      );
      const rawDeliveryCountry = deliveryDistinct
        ? (f.deliveryCountry || f.country || 'FR')
        : (f.country || 'FR');
      const deliveryCountry = String(rawDeliveryCountry).toUpperCase().slice(0, 2);

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
          siret: f.clientType === 'company' && f.siret.trim() ? f.siret.replace(/\s+/g, '') : undefined,
          address: (f.street || f.postalCode || f.city) ? {
            street: f.street,
            zipCode: f.postalCode,
            city: f.city,
            country,
          } : undefined,
          deliveryAddress: deliveryDistinct ? {
            street: f.deliveryStreet,
            zipCode: f.deliveryPostalCode,
            city: f.deliveryCity,
            country: deliveryCountry,
          } : undefined,
        },
        lines: allLines,
        subject: f.subject,
        freeText: undefined as string | undefined,
        discountPercent: parseFloat(f.discountPercent || '0') || undefined,
        inboxName,
      };

      // Mentions légales d'exonération de TVA — injectées dans le champ
      // pdf_invoice_free_text du devis Pennylane (celui qui apparaît sur
      // le PDF, cf. « ajouter une description »).
      // 2 cas d'exonération distincts, mentions différentes :
      //  A. LIC intracommunautaire : UE hors France + n° TVA intra fourni.
      //     Mention Charles 01/07/2026 : art. 262 ter I CGI + art. 138
      //     Directive 2006/112/CE.
      //  B. Exportation hors UE : pays hors UE (AD, CH, GB, US, etc.).
      //     Mention Charles 03/07/2026 : art. 262 I CGI (une seule
      //     référence, pas de directive UE puisque le client est hors UE).
      //     Aucun n° TVA intra requis pour cette exo.
      const freeTextLines: string[] = [];
      const isEuNonFr = EU_COUNTRIES_NON_FR.includes(country);
      const isHorsUE = country !== 'FR' && !isEuNonFr && country.length > 0;
      if (vatPercent === 0 && isEuNonFr && f.vatNumber) {
        freeTextLines.push('Exonération de TVA – Livraison intracommunautaire – article 262 ter I du CGI – article 138 de la directive 2006/112/CE.');
      } else if (vatPercent === 0 && isHorsUE) {
        freeTextLines.push('Exonération de TVA – exportation – article 262 I du CGI.');
      }
      // Backup lisibilité : quand l'adresse de livraison diffère de la
      // facturation, on la répète dans le free_text pour garantir sa
      // visibilité sur le PDF même si le template Pennylane ne rend pas le
      // bloc delivery_address structuré (02/07/2026).
      if (deliveryDistinct) {
        const deliveryLine = [
          f.deliveryStreet,
          `${f.deliveryPostalCode} ${f.deliveryCity}`.trim(),
          deliveryCountry,
        ].filter((s) => s && s.trim().length > 0).join(', ');
        if (deliveryLine) {
          freeTextLines.push(`Livraison à : ${deliveryLine}`);
        }
      }
      if (freeTextLines.length > 0) {
        payload.freeText = freeTextLines.join('\n');
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
