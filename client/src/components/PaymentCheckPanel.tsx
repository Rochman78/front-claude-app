import { useState, useEffect } from 'react';

const API_BASE = window.location.origin;

interface BankTx {
  id: string;
  date: string;
  amount: string;
  label: string;
  currency: string;
  outstanding_balance: string;
  score: number;
  matchReasons: string[];
  alreadyConfirmed?: boolean;
}

interface SearchResponse {
  quote: {
    quoteNumber: string;
    expectedAmount: number | null;
    pdfUrl: string;
    pennylaneUrl: string;
    createdAt: string;
  };
  bankAccountId: string;
  searchWindowDays: number;
  scanned: number;
  results: BankTx[];
  alreadyConfirmedCount: number;
}

interface PaymentCheckPanelProps {
  frontConversationId: string;
  storeCode: string;
  customerName: string;
  expectedAmount?: number;
  quoteNumber: string;
  onClose: () => void;
  onPushed?: () => void;
}

export default function PaymentCheckPanel({
  frontConversationId,
  storeCode,
  customerName,
  expectedAmount,
  quoteNumber,
  onClose,
  onPushed,
}: PaymentCheckPanelProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<SearchResponse | null>(null);
  const [selectedTxId, setSelectedTxId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmResult, setConfirmResult] = useState<{ ok: boolean; message: string } | null>(null);

  // Champs éditables — pré-remplis depuis les props, modifiables par le collab.
  // Utile si la BDD n'a pas le montant TTC (cas des 327 anciens devis) ou si
  // le nom remonté par le contexte Front est incomplet.
  const [editName, setEditName] = useState<string>(customerName || '');
  const [editAmount, setEditAmount] = useState<string>(
    expectedAmount !== undefined && !Number.isNaN(expectedAmount)
      ? expectedAmount.toFixed(2)
      : ''
  );

  // Trigger qui force un re-run de la recherche quand on clique sur "Relancer".
  const [searchTrigger, setSearchTrigger] = useState(0);

  // (Re)cherche les transactions candidates avec les valeurs courantes des champs.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);
    setSelectedTxId(null);
    setConfirmResult(null);

    const url = new URL(`${API_BASE}/api/plugin/bank-transactions/search`);
    url.searchParams.set('front_conversation_id', frontConversationId);
    url.searchParams.set('store_code', storeCode);
    if (editName.trim()) url.searchParams.set('customer_name', editName.trim());
    const amountNum = parseFloat((editAmount || '').replace(',', '.'));
    if (!Number.isNaN(amountNum) && amountNum > 0) {
      url.searchParams.set('expected_amount', String(amountNum));
    }

    fetch(url.toString())
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok) {
          setError(body?.error || `Erreur ${res.status}`);
          setLoading(false);
          return;
        }
        setData(body as SearchResponse);
        // Auto-sélectionner la 1ère ligne si score ≥ 100 (montant exact + autre critère)
        if (body?.results?.length > 0 && body.results[0].score >= 100) {
          setSelectedTxId(body.results[0].id);
        }
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.message || 'Erreur recherche');
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // searchTrigger volontaire dans deps → relance via le bouton.
    // editName/editAmount NE sont PAS dans deps → on évite un refetch à chaque
    // frappe clavier (le collab modifie puis clique "Relancer").
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frontConversationId, storeCode, searchTrigger]);

  const selected = data?.results.find((tx) => tx.id === selectedTxId) || null;

  const handleConfirm = async () => {
    if (!selected) return;
    setConfirming(true);
    setConfirmResult(null);
    try {
      const res = await fetch(`${API_BASE}/api/plugin/payment-confirmed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          frontConversationId,
          storeCode,
          transactionId: selected.id,
          transactionLabel: selected.label,
          transactionAmount: selected.amount,
          customerFirstName: (editName || customerName || '').split(' ')[0] || '',
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setConfirmResult({ ok: false, message: body?.error || `Erreur ${res.status}` });
        setConfirming(false);
        return;
      }
      if (body?.status === 'already_confirmed') {
        setConfirmResult({ ok: true, message: 'Ce virement avait déjà été confirmé. Pas de nouveau brouillon.' });
      } else if (body?.pushSuccess) {
        setConfirmResult({ ok: true, message: 'Brouillon de confirmation poussé dans Front App.' });
        onPushed?.();
      } else {
        setConfirmResult({ ok: false, message: body?.pushError || 'Confirmation enregistrée mais push KO.' });
      }
    } catch (err) {
      setConfirmResult({ ok: false, message: err instanceof Error ? err.message : 'erreur' });
    } finally {
      setConfirming(false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
        background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1500,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'white', borderRadius: '12px', padding: '20px',
          maxWidth: '520px', width: '95%', maxHeight: '85vh', overflow: 'auto',
          boxShadow: '0 4px 20px rgba(0,0,0,0.15)', color: '#000',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px' }}>
          <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 700 }}>💳 Vérifier virement reçu</h3>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', fontSize: '18px', cursor: 'pointer', color: '#666', padding: '0 4px' }}
          >
            ×
          </button>
        </div>

        {/* Bloc infos devis — éditable (utile pour les anciens devis sans amount BDD
            ou si le nom remonté par Front est incomplet) */}
        <div style={{ background: '#f0f7ff', border: '1px solid #cfe2ff', borderRadius: '8px', padding: '10px 12px', marginBottom: '12px', fontSize: '12px', lineHeight: 1.5 }}>
          <div style={{ marginBottom: '6px' }}>
            <strong>Devis :</strong> {quoteNumber}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr', alignItems: 'center', gap: '6px 8px', marginBottom: '6px' }}>
            <label htmlFor="pcp-name" style={{ fontWeight: 600 }}>Client :</label>
            <input
              id="pcp-name"
              type="text"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              placeholder="Prénom Nom"
              style={{ padding: '5px 8px', fontSize: '12px', border: '1px solid #cbd5e0', borderRadius: '4px', color: '#000', background: 'white' }}
            />
            <label htmlFor="pcp-amount" style={{ fontWeight: 600 }}>Montant TTC :</label>
            <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
              <input
                id="pcp-amount"
                type="text"
                inputMode="decimal"
                value={editAmount}
                onChange={(e) => setEditAmount(e.target.value)}
                placeholder="ex : 1247.80"
                style={{ flex: 1, padding: '5px 8px', fontSize: '12px', border: '1px solid #cbd5e0', borderRadius: '4px', color: '#000', background: 'white' }}
              />
              <span style={{ color: '#666' }}>€</span>
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button
              onClick={() => setSearchTrigger((t) => t + 1)}
              disabled={loading}
              style={{
                fontSize: '11px', padding: '4px 10px',
                border: '1px solid #4a90d9', borderRadius: '4px',
                background: loading ? '#cbd5e0' : 'white', color: loading ? '#666' : '#2c5282',
                cursor: loading ? 'not-allowed' : 'pointer', fontWeight: 600,
              }}
            >
              {loading ? 'Recherche…' : '🔄 Relancer la recherche'}
            </button>
          </div>
        </div>

        {loading && (
          <div style={{ textAlign: 'center', padding: '24px', color: '#666', fontSize: '13px' }}>
            Recherche des virements correspondants sur le compte DEVIS…
          </div>
        )}

        {error && (
          <div style={{ background: '#fff5f5', border: '1px solid #feb2b2', borderRadius: '6px', padding: '10px', color: '#9b2c2c', fontSize: '12px' }}>
            ⚠️ {error}
          </div>
        )}

        {!loading && !error && data && (
          <>
            <div style={{ fontSize: '11px', color: '#666', marginBottom: '8px' }}>
              {data.scanned} transactions scannées sur {data.searchWindowDays} jours
              {data.alreadyConfirmedCount > 0 && ` — ${data.alreadyConfirmedCount} déjà confirmée(s) pour cette conv`}
            </div>

            {data.results.length === 0 && (
              <div style={{ background: '#fffbf0', border: '1px solid #f6e05e', borderRadius: '6px', padding: '12px', fontSize: '12px', color: '#744210' }}>
                Aucune transaction candidate trouvée. Le virement n'est peut-être pas encore arrivé,
                ou le libellé ne contient ni le numéro de devis ni le nom du client.
              </div>
            )}

            {data.results.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '12px' }}>
                {data.results.map((tx) => {
                  const isSelected = tx.id === selectedTxId;
                  const isHighConfidence = tx.score >= 100;
                  return (
                    <div
                      key={tx.id}
                      onClick={() => !tx.alreadyConfirmed && setSelectedTxId(tx.id)}
                      style={{
                        border: isSelected ? '2px solid #4a90d9' : '1px solid #ddd',
                        background: tx.alreadyConfirmed ? '#f0f0f0' : (isSelected ? '#f0f7ff' : 'white'),
                        borderRadius: '8px',
                        padding: '10px 12px',
                        cursor: tx.alreadyConfirmed ? 'not-allowed' : 'pointer',
                        opacity: tx.alreadyConfirmed ? 0.6 : 1,
                        fontSize: '12px',
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '4px' }}>
                        <div style={{ fontWeight: 700, fontSize: '13px' }}>
                          {parseFloat(tx.amount).toFixed(2)} {tx.currency || 'EUR'}
                        </div>
                        <div style={{ color: '#666', fontSize: '11px' }}>{tx.date}</div>
                      </div>
                      <div style={{ color: '#333', wordBreak: 'break-word', marginBottom: '4px' }}>
                        {tx.label}
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                        {tx.matchReasons.map((r, i) => (
                          <span key={i} style={{
                            fontSize: '10px', padding: '2px 6px', borderRadius: '4px',
                            background: isHighConfidence ? '#c6f6d5' : '#fefcbf',
                            color: isHighConfidence ? '#22543d' : '#744210',
                          }}>
                            {r}
                          </span>
                        ))}
                        {tx.alreadyConfirmed && (
                          <span style={{ fontSize: '10px', padding: '2px 6px', borderRadius: '4px', background: '#e9d8fd', color: '#553c9a' }}>
                            déjà confirmée
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {confirmResult && (
              <div style={{
                marginBottom: '10px', padding: '10px', borderRadius: '6px', fontSize: '12px',
                background: confirmResult.ok ? '#f0fdf4' : '#fff5f5',
                color: confirmResult.ok ? '#22543d' : '#9b2c2c',
                border: `1px solid ${confirmResult.ok ? '#9ae6b4' : '#feb2b2'}`,
              }}>
                {confirmResult.ok ? '✅ ' : '⚠️ '}{confirmResult.message}
              </div>
            )}

            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                onClick={onClose}
                style={{
                  flex: '0 0 auto', padding: '10px 16px', fontSize: '13px',
                  border: '1px solid #ddd', borderRadius: '6px', background: 'white', cursor: 'pointer', color: '#000',
                }}
              >
                Fermer
              </button>
              <button
                onClick={handleConfirm}
                disabled={!selected || confirming || selected.alreadyConfirmed || confirmResult?.ok}
                style={{
                  flex: 1, padding: '10px 16px', fontSize: '13px', fontWeight: 600,
                  border: 'none', borderRadius: '6px',
                  background: (!selected || confirming || selected?.alreadyConfirmed || confirmResult?.ok) ? '#cbd5e0' : '#38a169',
                  color: 'white',
                  cursor: (!selected || confirming || selected?.alreadyConfirmed || confirmResult?.ok) ? 'not-allowed' : 'pointer',
                }}
              >
                {confirming ? 'Envoi…' : confirmResult?.ok ? 'Brouillon poussé' : 'Confirmer & pousser brouillon'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
