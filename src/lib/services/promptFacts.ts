/**
 * Faits injectés par le code dans le message d'analyse (28/09/2026).
 *
 * Plutôt que de laisser le modèle retrouver un prix dans les ~100 000
 * caractères de prix-ht-standards.txt (erreurs observées au banc de rejeu :
 * mauvaise ligne lue, mauvaise colonne TVA, prix repris de l'historique), on
 * lui recopie les lignes EXACTES des produits détectés par le pré-passage SKU,
 * et le devis Pennylane déjà émis sur la conversation.
 */
import pool from '@/lib/db';

interface CatalogPriceRow {
  sku: string;
  label: string;
  ttc: string;
  ht: { rate: string; value: string }[];
}

/** Lit prix-ht-standards.txt : en-tête « typologie | … | TTC | HT 0% | … »
 *  puis lignes à 19 colonnes (6 descriptives, TTC, 12 colonnes HT). */
export function parseCatalogPrices(content: string): Map<string, CatalogPriceRow> {
  const out = new Map<string, CatalogPriceRow>();
  let rates: string[] = [];
  for (const raw of content.split('\n')) {
    const parts = raw.split('|').map((p) => p.trim());
    if (parts.length !== 19) continue;
    if (parts[0].toLowerCase() === 'typologie') {
      rates = parts.slice(7).map((h) => h.replace(/^HT\s*/i, ''));
      continue;
    }
    if (!/^\d{12,14}$/.test(parts[5]) || rates.length !== 12) continue;
    out.set(parts[5], {
      sku: parts[5],
      label: parts.slice(0, 5).filter((p) => p && p !== 'n/a').join(' '),
      ttc: parts[6],
      ht: parts.slice(7).map((value, i) => ({ rate: rates[i], value })),
    });
  }
  return out;
}

const fmt = (v: string) => v.replace('.', ',');

/** Bloc « prix exacts » pour les SKU détectés. Vide si aucun SKU reconnu. */
export function buildCatalogFactsBlock(standardsContent: string, skus: string[]): string {
  const prices = parseCatalogPrices(standardsContent);
  const rows = skus.map((s) => prices.get(s)).filter((r): r is CatalogPriceRow => !!r);
  if (rows.length === 0) return '';
  const lines = rows.map((r) =>
    `  • SKU ${r.sku} | ${r.label} | TTC ${fmt(r.ttc)} € | HT : ${r.ht.map((h) => `${h.rate} ${fmt(h.value)}`).join(' · ')}`
  );
  return `══════════════════════════════════════════════════════
💶 PRIX CATALOGUE EXACTS DES PRODUITS DÉTECTÉS (copie de prix-ht-standards.txt)

${lines.join('\n')}

Ces montants sont la SOURCE DE VÉRITÉ pour ces SKU : recopie-les tels quels. Choisis la colonne HT du taux de TVA du PAYS DE LIVRAISON (HT 0% si livraison intracommunautaire avec n° TVA valide ou export hors UE). Ne recalcule jamais un HT depuis le TTC. Un produit absent de cette liste n'a pas été reconnu automatiquement : vérifie-le dans prix-ht-standards.txt comme d'habitude.
══════════════════════════════════════════════════════`;
}

/** Bloc « devis déjà émis » (dernier devis Pennylane enregistré pour la conv). */
export async function buildIssuedQuoteBlock(frontConversationId: string, storeCode: string): Promise<string> {
  try {
    const { rows } = await pool.query(
      'SELECT quote_number, amount, created_at FROM conversation_quotes WHERE front_conversation_id = $1 AND store_code = $2 LIMIT 1',
      [frontConversationId, storeCode]
    );
    const q = rows[0];
    if (!q) return '';
    const date = new Date(q.created_at).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' });
    const amount = q.amount ? `, montant TTC ${String(q.amount).replace('.', ',')} €` : '';
    return `══════════════════════════════════════════════════════
📄 DEVIS DÉJÀ ÉMIS DANS CETTE CONVERSATION (Pennylane)

  • ${q.quote_number} du ${date}${amount}

Tout rappel de prix de ce devis dans le brouillon reprend EXACTEMENT ce montant (remises comprises) : ne le recalcule pas depuis la grille. Si la demande du client modifie le devis (ajout, retrait, remise), signale en QUESTIONS qu'un nouveau devis devra être généré.
══════════════════════════════════════════════════════`;
  } catch (err) {
    console.warn('[promptFacts] lecture conversation_quotes impossible (non bloquant):', err);
    return '';
  }
}
