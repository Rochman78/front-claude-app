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
    // Comptes DEVIS Pennylane à interroger (union des résultats).
    // `PENNYLANE_DEVIS_BANK_ACCOUNT_IDS` (pluriel, IDs séparés par virgule) prend
    // le pas s'il est défini. Sinon, fallback sur le singulier `PENNYLANE_DEVIS_
    // BANK_ACCOUNT_ID` (rétrocompat avec la conf 1 compte avant 26/06/2026).
    const idsRaw = process.env.PENNYLANE_DEVIS_BANK_ACCOUNT_IDS
      || process.env.PENNYLANE_DEVIS_BANK_ACCOUNT_ID
      || '';
    const bankAccountIds = idsRaw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s))
      .map((s) => parseInt(s, 10));
    if (bankAccountIds.length === 0) {
      return NextResponse.json(
        { error: 'PENNYLANE_DEVIS_BANK_ACCOUNT_IDS non configuré (au moins 1 ID de compte DEVIS Pennylane)' },
        { status: 500 }
      );
    }

    await initDB();

    const sp = req.nextUrl.searchParams;
    const frontConvId = sp.get('front_conversation_id') || '';
    const storeCode = sp.get('store_code') || '';
    const customerName = sp.get('customer_name') || '';
    const expectedAmountRaw = sp.get('expected_amount') || '';
    const customQuoteNumber = (sp.get('quote_number') || '').trim();

    if (!frontConvId || !storeCode) {
      return NextResponse.json({ error: 'front_conversation_id et store_code requis' }, { status: 400 });
    }

    const expectedAmount = expectedAmountRaw ? parseFloat(expectedAmountRaw) : NaN;

    // 1. Récupérer le devis en BDD (optionnel : si custom quote_number fourni
    //    par le collab, il prévaut sur la BDD, et la conv peut ne PAS avoir de
    //    devis stocké — cas devis créé hors plugin).
    const { rows } = await pool.query(
      'SELECT quote_number, amount, pdf_url, pennylane_url, created_at FROM conversation_quotes WHERE front_conversation_id = $1 AND store_code = $2',
      [frontConvId, storeCode]
    );
    const bddQuote = rows[0] || null;

    // Le n° de devis est OPTIONNEL pour la recherche (Charles 15/06/2026 :
    // "qu'il puisse chercher juste selon le montant"). Le scoring fonctionne
    // toujours sans : montant exact +100, nom +30 si fourni, n° devis +80 si
    // fourni. Au moins UN critère discriminant doit néanmoins être fourni
    // (montant OU nom OU n° devis), sinon le top 10 serait juste les 10 plus
    // grosses tx récentes du compte DEVIS, sans aucune pertinence métier.
    const quoteNumber: string = customQuoteNumber || bddQuote?.quote_number || '';
    const quoteDate: string | null = bddQuote?.created_at ? String(bddQuote.created_at).substring(0, 10) : null;
    const bddAmount = parseFloat(bddQuote?.amount || '');
    const finalExpectedAmount = !Number.isNaN(expectedAmount) ? expectedAmount : (!Number.isNaN(bddAmount) ? bddAmount : null);

    const hasAmount = finalExpectedAmount !== null && !Number.isNaN(finalExpectedAmount) && finalExpectedAmount > 0;
    const hasName = customerName.trim().length >= 3;
    const hasQuoteNumber = quoteNumber.length > 0;
    if (!hasAmount && !hasName && !hasQuoteNumber) {
      return NextResponse.json({
        error: 'Au moins un critère est requis : montant TTC, nom client, ou n° de devis.',
      }, { status: 400 });
    }

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

    // 4. Appels Pennylane parallèles — 1 par compte DEVIS, puis union des
    // résultats. Pennylane v2 ne supporte pas d'operator `in` sur bank_account_id
    // (testé : 400) → on fait N requêtes et on merge. Pas de `sort=…` : v2
    // rejette toutes les syntaxes courantes (testé : 400). Tri par score
    // côté serveur après réception.
    const t0 = Date.now();
    const perAccountResults = await Promise.all(
      bankAccountIds.map(async (accountId) => {
        const filter = JSON.stringify([
          { field: 'bank_account_id', operator: 'eq', value: accountId },
          { field: 'date', operator: 'gteq', value: sinceStr },
        ]);
        const url = `${PENNYLANE_API_URL}/transactions?limit=100&filter=${encodeURIComponent(filter)}`;
        const r = await fetch(url, {
          headers: {
            Authorization: `Bearer ${process.env.PENNYLANE_API_TOKEN}`,
            Accept: 'application/json',
          },
        });
        if (!r.ok) {
          const errBody = await r.text();
          console.error(`[bank-transactions/search] Pennylane ${r.status} compte ${accountId}:`, errBody.substring(0, 200));
          return { accountId, ok: false, items: [] as PnlnTransaction[], status: r.status };
        }
        const d = await r.json();
        return { accountId, ok: true, items: (d.items || []) as PnlnTransaction[], status: 200 };
      })
    );
    const elapsed = Date.now() - t0;

    // Si TOUS les comptes ont échoué, on remonte une 502. Si un seul échoue,
    // on continue avec les autres (résilience : un compte temporairement
    // déconnecté côté Pennylane ne doit pas bloquer la vérif sur l'autre).
    const failedCount = perAccountResults.filter((r) => !r.ok).length;
    if (failedCount === bankAccountIds.length) {
      const first = perAccountResults[0];
      return NextResponse.json(
        { error: `Pennylane ${first.status} sur tous les comptes`, detail: 'aucun compte n\'a répondu correctement' },
        { status: 502 }
      );
    }

    // Merge + déduplique par id (sécurité — un même tx ne devrait pas
    // apparaître sur 2 comptes, mais on protège quand même).
    const seenTxIds = new Set<string>();
    const items: PnlnTransaction[] = [];
    for (const r of perAccountResults) {
      for (const tx of r.items) {
        const key = String(tx.id);
        if (!seenTxIds.has(key)) {
          seenTxIds.add(key);
          items.push(tx);
        }
      }
    }
    console.log(`[bank-transactions/search] convId=${frontConvId} quote=${quoteNumber} expected=${finalExpectedAmount} → ${items.length} tx (${bankAccountIds.length} comptes, ${failedCount} en échec) en ${elapsed}ms`);

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
        pdfUrl: bddQuote?.pdf_url || '',
        pennylaneUrl: bddQuote?.pennylane_url || '',
        createdAt: bddQuote?.created_at || '',
      },
      bankAccountIds,
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
