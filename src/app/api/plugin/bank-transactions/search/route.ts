import { NextRequest, NextResponse } from 'next/server';
import pool, { initDB } from '@/lib/db';

const PENNYLANE_API_URL = 'https://app.pennylane.com/api/external/v2';
const SEARCH_WINDOW_DAYS = 60;
const MAX_RESULTS = 10;

interface PnlnTransaction {
  id: number;
  amount: string;
  currency: string;
  date: string;
  label: string;
  outstanding_balance?: string;
  bank_account?: { id: number };
}

interface ScoredTx {
  id: string;
  date: string;
  amount: string;
  label: string;
  currency: string;
  outstanding_balance: string;
  score: number;
  matchReasons: string[];
}

function normalize(s: string): string {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreTransaction(
  tx: PnlnTransaction,
  quoteNumber: string,
  customerName: string,
  expectedAmount: number | null,
  quoteDate: string | null
): ScoredTx {
  const label = tx.label || '';
  const labelNorm = normalize(label);
  const reasons: string[] = [];
  let score = 0;

  // 1) Montant exact (tolérance 0,01 €) — critère fort
  const txAmount = parseFloat(tx.amount);
  if (expectedAmount !== null && !Number.isNaN(txAmount)) {
    const diff = Math.abs(txAmount - expectedAmount);
    if (diff < 0.01) {
      score += 100;
      reasons.push(`montant exact ${expectedAmount.toFixed(2)} €`);
    } else if (diff < 1) {
      score += 60;
      reasons.push(`montant proche (~${diff.toFixed(2)} € d'écart)`);
    }
  }

  // 2) Numéro de devis dans le label — critère certain
  if (quoteNumber) {
    const qNorm = normalize(quoteNumber);
    const qShort = qNorm.replace(/^d /, '').replace(/-/g, '');
    if (qNorm && labelNorm.includes(qNorm)) {
      score += 80;
      reasons.push(`n° devis ${quoteNumber} dans le libellé`);
    } else if (qShort && labelNorm.includes(qShort)) {
      score += 70;
      reasons.push(`n° devis (sans tirets) dans le libellé`);
    }
  }

  // 3) Nom client dans le label — critère probable
  if (customerName) {
    const parts = normalize(customerName).split(' ').filter((p) => p.length >= 3);
    const matched = parts.filter((p) => labelNorm.includes(p));
    if (matched.length > 0) {
      score += matched.length === parts.length ? 30 : 15;
      reasons.push(`nom client (${matched.join(', ')})`);
    }
  }

  // 4) Date ≥ date du devis — léger bonus
  if (quoteDate && tx.date >= quoteDate) {
    score += 10;
  }

  return {
    id: String(tx.id),
    date: tx.date,
    amount: tx.amount,
    label: tx.label,
    currency: tx.currency,
    outstanding_balance: tx.outstanding_balance || '',
    score,
    matchReasons: reasons,
  };
}

/**
 * GET /api/plugin/bank-transactions/search
 *   ?front_conversation_id=cnv_X&store_code=LFC&customer_name=Jean+Dupont&expected_amount=1247.80
 *
 * Cherche dans le compte bancaire DEVIS (Pennylane) les transactions
 * candidates correspondant au devis de la conversation. Renvoie un top 10
 * trié par score décroissant.
 */
export async function GET(req: NextRequest) {
  try {
    if (!process.env.PENNYLANE_API_TOKEN) {
      return NextResponse.json({ error: 'PENNYLANE_API_TOKEN non configuré' }, { status: 500 });
    }
    const bankAccountId = process.env.PENNYLANE_DEVIS_BANK_ACCOUNT_ID;
    if (!bankAccountId) {
      return NextResponse.json(
        { error: 'PENNYLANE_DEVIS_BANK_ACCOUNT_ID non configuré (compte DEVIS Pennylane)' },
        { status: 500 }
      );
    }

    await initDB();

    const sp = req.nextUrl.searchParams;
    const frontConvId = sp.get('front_conversation_id') || '';
    const storeCode = sp.get('store_code') || '';
    const customerName = sp.get('customer_name') || '';
    const expectedAmountRaw = sp.get('expected_amount') || '';

    if (!frontConvId || !storeCode) {
      return NextResponse.json({ error: 'front_conversation_id et store_code requis' }, { status: 400 });
    }

    const expectedAmount = expectedAmountRaw ? parseFloat(expectedAmountRaw) : NaN;

    // 1. Récupérer le devis en BDD
    const { rows } = await pool.query(
      'SELECT quote_number, amount, pdf_url, pennylane_url, created_at FROM conversation_quotes WHERE front_conversation_id = $1 AND store_code = $2',
      [frontConvId, storeCode]
    );
    if (rows.length === 0) {
      return NextResponse.json({ error: 'Aucun devis trouvé pour cette conversation' }, { status: 404 });
    }
    const quote = rows[0];
    const quoteNumber: string = quote.quote_number || '';
    const quoteDate: string | null = quote.created_at ? String(quote.created_at).substring(0, 10) : null;
    const bddAmount = parseFloat(quote.amount || '');
    const finalExpectedAmount = !Number.isNaN(expectedAmount) ? expectedAmount : (!Number.isNaN(bddAmount) ? bddAmount : null);

    // 2. Confirmations déjà enregistrées pour cette conv (pour les marquer côté UI)
    const { rows: confRows } = await pool.query(
      'SELECT transaction_id FROM payment_confirmations WHERE front_conversation_id = $1',
      [frontConvId]
    );
    const alreadyConfirmedTxIds = new Set(confRows.map((r) => String(r.transaction_id)));

    // 3. Fenêtre temporelle : aujourd'hui − SEARCH_WINDOW_DAYS
    const since = new Date();
    since.setDate(since.getDate() - SEARCH_WINDOW_DAYS);
    const sinceStr = since.toISOString().substring(0, 10);

    // 4. Appel Pennylane — filtre bank_account_id + date >= since
    const filter = JSON.stringify([
      { field: 'bank_account_id', operator: 'eq', value: parseInt(bankAccountId, 10) },
      { field: 'date', operator: 'gteq', value: sinceStr },
    ]);
    // Pas de `sort=…` : Pennylane v2 rejette toutes les syntaxes courantes
    // (`sort=date:desc`, `sort=-date`, `sort=date`) avec 400 "Invalid sort
    // format". On trie côté serveur par score après réception — le tri
    // Pennylane par date n'apporte rien au scoring final.
    const url = `${PENNYLANE_API_URL}/transactions?limit=100&filter=${encodeURIComponent(filter)}`;

    const t0 = Date.now();
    const pnlnRes = await fetch(url, {
      headers: {
        Authorization: `Bearer ${process.env.PENNYLANE_API_TOKEN}`,
        Accept: 'application/json',
      },
    });
    const elapsed = Date.now() - t0;

    if (!pnlnRes.ok) {
      const errBody = await pnlnRes.text();
      console.error(`[bank-transactions/search] Pennylane ${pnlnRes.status} (${elapsed}ms):`, errBody.substring(0, 300));
      return NextResponse.json(
        { error: `Pennylane ${pnlnRes.status}`, detail: errBody.substring(0, 300) },
        { status: 502 }
      );
    }

    const data = await pnlnRes.json();
    const items: PnlnTransaction[] = data.items || [];
    console.log(`[bank-transactions/search] convId=${frontConvId} quote=${quoteNumber} expected=${finalExpectedAmount} → ${items.length} tx en ${elapsed}ms`);

    // 5. Scorer et trier
    const scored = items
      .map((tx) => scoreTransaction(tx, quoteNumber, customerName, finalExpectedAmount, quoteDate))
      .filter((s) => s.score > 0) // au moins 1 critère matche
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_RESULTS)
      .map((s) => ({
        ...s,
        alreadyConfirmed: alreadyConfirmedTxIds.has(s.id),
      }));

    return NextResponse.json({
      quote: {
        quoteNumber,
        expectedAmount: finalExpectedAmount,
        pdfUrl: quote.pdf_url || '',
        pennylaneUrl: quote.pennylane_url || '',
        createdAt: quote.created_at || '',
      },
      bankAccountId,
      searchWindowDays: SEARCH_WINDOW_DAYS,
      scanned: items.length,
      results: scored,
      alreadyConfirmedCount: alreadyConfirmedTxIds.size,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'erreur inconnue';
    console.error('[bank-transactions/search] error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
