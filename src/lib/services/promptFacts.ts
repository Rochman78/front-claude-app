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
import { callClaude } from '@/lib/services/claudeService';

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


/** Catalogue réduit aux 6 colonnes utiles au repérage (typologie, forme,
 *  matière, couleur, taille, SKU) : ~26 k car. au lieu de ~100 k. Les prix
 *  ne servent pas à trouver le SKU ; le bloc 💶 les recopie ensuite depuis
 *  la ligne complète (buildCatalogFactsBlock). */
export function compactStandardsForSkuMatch(standardsContent: string): string {
  return standardsContent
    .split('\n')
    .filter((l) => /\|\s*\d{13}\s*\|/.test(l))
    .map((l) => l.split('|').slice(0, 6).map((c) => c.trim()).join(' | '))
    .join('\n');
}

/** Pré-passage SKU (Sonnet 4.6) : identifie les produits STANDARD demandés
 *  dans le mail et renvoie { SKU → nom, quantité }, ou null si aucun.
 *  Rebasculé sur Sonnet 4.6 le 01/07/2026 : Haiku confondait couleurs proches
 *  (sable ↔ beige) et tailles inversées → mauvais bloc STOCK en cascade.
 *  Utilisé par /api/plugin/analyze, /api/plugin/message et par
 *  scripts/replay-agents/replay.ts. */
export async function detectStandardSkus(
  mailContent: string,
  standardsContent: string,
  opts: { label?: string; storeCode?: string } = {}
): Promise<Record<string, { name: string; qtyDemanded: string }> | null> {
  const skuExtractPrompt = `Tu es un assistant qui identifie les produits demandés par le client dans un mail, et qui retrouve les SKU correspondants dans la liste des produits standards.

MAIL DU CLIENT :
${mailContent.substring(0, 4000)}

LISTE DES PRODUITS STANDARDS (colonnes : typologie | forme | matiere | couleur | taille | SKU) :
${compactStandardsForSkuMatch(standardsContent)}

RÈGLES :
- La liste contient des filets standards (par couleur / matière / taille) ET des accessoires (mâts, kits de fixation, cordes, colliers, etc.). Parcourir TOUTE la liste.
- Identifier les produits CATALOGUE STANDARD que le client demande (couleur, taille, finition, ou accessoire précis).
- Forme (rectangle ≠ carré ≠ triangle) et matière (polyester ≠ câble acier ≠ coco) doivent aussi correspondre.
- Vérifier ATTENTIVEMENT que la COULEUR ET la TAILLE demandées correspondent EXACTEMENT à une ligne avant de retourner un SKU. Les tailles sont RÉVERSIBLES (3x4 = 4x3). Si la correspondance n'est pas exacte (taille proche, couleur proche), NE PAS retourner de SKU — ne JAMAIS inventer ni proposer un SKU "approchant".
- Si le client demande du sur mesure (dimensions non standard), ne retourner AUCUN SKU.
- Retourner UNIQUEMENT les SKU trouvés, un par ligne, format : SKU|nom_produit|quantité_demandée
- Si aucun produit standard identifié, retourner : AUCUN

Exemple de réponse :
3760388670833|Filet camouflage noir 2x2|5
3760388670796|Filet camouflage noir 2x3|3`;
  const skuResult = await callClaude(
    [{ role: 'user', content: skuExtractPrompt }],
    { model: 'claude-sonnet-4-6', maxTokens: 500, label: opts.label || 'sku-detect', storeCode: opts.storeCode }
  );
  if (!skuResult || skuResult.includes('AUCUN')) return null;
  const skuMap: Record<string, { name: string; qtyDemanded: string }> = {};
  for (const line of skuResult.trim().split('\n').filter((l) => l.includes('|'))) {
    const [sku, name, qty] = line.split('|');
    if (sku && /^37\d{11}$/.test(sku.trim())) {
      skuMap[sku.trim()] = { name: (name || '').trim(), qtyDemanded: (qty || '?').trim() };
    }
  }
  return Object.keys(skuMap).length > 0 ? skuMap : null;
}
