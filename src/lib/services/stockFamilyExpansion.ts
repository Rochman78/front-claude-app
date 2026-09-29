/**
 * Élargissement automatique du stock check en cas de rupture (03/07/2026).
 *
 * Motivation : quand un SKU catalogue demandé par le client est en rupture
 * (Octopia stock = 0), Claude a besoin de connaître le stock réel des
 * alternatives « famille » (mêmes typologie/forme/matière, autres tailles
 * ou autres couleurs) pour pouvoir les proposer directement dans le
 * brouillon sans flagger « je ne connais pas le stock » en QUESTIONS.
 *
 * Utilisé par /analyze et /message (comportement identique côté stock,
 * seul le format d'affichage du bloc STOCK OCTOPIA diffère).
 */

/** Ligne du prix-ht-standards.txt parsée avec sa métadonnée. */
export interface CatalogRow {
  sku: string;
  typologie: string;
  forme: string;
  matiere: string;
  couleur: string;
  taille: string;
  label: string;
}

/** Parse le contenu de prix-ht-standards.txt (format tabulaire 19 colonnes)
 *  et retourne la liste des lignes avec métadonnées.
 *  Ignore les lignes de section (═, -, ⚠, ℹ) et les lignes mal formées. */
export function parseStandardsRows(content: string): CatalogRow[] {
  const out: CatalogRow[] = [];
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('═') || line.startsWith('-') || line.startsWith('⚠') || line.startsWith('ℹ')) continue;
    const parts = line.split('|').map((p) => p.trim());
    if (parts.length !== 19) continue;
    const sku = parts[5];
    if (!/^\d{12,14}$/.test(sku)) continue;
    out.push({
      sku,
      typologie: parts[0].toLowerCase(),
      forme: parts[1].toLowerCase(),
      matiere: parts[2].toLowerCase(),
      couleur: parts[3].toLowerCase(),
      taille: parts[4].toLowerCase(),
      label: `${parts[0]} ${parts[1]} ${parts[2]} ${parts[3]} ${parts[4]}`.replace(/\s+/g, ' ').trim(),
    });
  }
  return out;
}

/** Retourne les SKU « famille » d'une ligne rupture :
 *  - Même typologie/forme/matiere/couleur, différentes tailles
 *  - Même typologie/forme/matiere/taille, différentes couleurs
 *  Exclut la ligne de départ + les SKU déjà présents dans excludeSet.
 *  Cap total à `limit` (défaut 12) pour éviter l'explosion Octopia (limite
 *  500 ms entre calls → 6 s pour 12 SKU en série). */
export function findFamilySkus(
  rows: CatalogRow[],
  base: CatalogRow,
  excludeSet: Set<string>,
  limit = 12,
): CatalogRow[] {
  const found: CatalogRow[] = [];
  for (const r of rows) {
    if (r.sku === base.sku || excludeSet.has(r.sku)) continue;
    const sameFamily = r.typologie === base.typologie && r.forme === base.forme && r.matiere === base.matiere;
    if (!sameFamily) continue;
    const isSizeAlt = r.couleur === base.couleur && r.taille !== base.taille;
    const isColorAlt = r.taille === base.taille && r.couleur !== base.couleur;
    if (!isSizeAlt && !isColorAlt) continue;
    found.push(r);
    if (found.length >= limit) break;
  }
  return found;
}

/** Le produit peut-il être proposé en sur-mesure en cas de rupture / stock
 *  partiel ? Seuls les FILETS polyester / câble acier se fabriquent sur
 *  mesure. Coco (toiles, rideaux), accessoires et échantillons : standard
 *  uniquement, et la boutique COCO n'a aucun sur-mesure (cas cnv_1mcdaown
 *  28/09/2026 : « solde fabriqué sur mesure » proposé sur une toile coco).
 *  Ligne catalogue introuvable → on se rabat sur le nom renvoyé par le
 *  matching SKU. */
export function canBeMadeToMeasure(
  row: CatalogRow | undefined,
  productName: string,
  storeCode: string
): boolean {
  if (storeCode.toUpperCase() === 'COCO') return false;
  if (row) return row.typologie === 'filet' && !row.matiere.includes('coco');
  return !/coco|accessoire|échantillon|echantillon|mât|kit|corde|collier|borne/i.test(productName);
}

/** SKU dont le stock n'est PAS suivi par Octopia (Charles 29/09/2026) : on
 *  n'interroge pas Octopia (qui répondrait 0 ou rien → fausse rupture) et
 *  l'agent demande le stock au gérant. Vaut pour toutes les boutiques qui
 *  vendent ces produits. Ajouter ici tout nouveau produit géré ailleurs. */
export const STOCK_HORS_OCTOPIA: Record<string, string> = {
  '3770043027001': 'mât en bois Robinier',
  '3760388679379': 'parasol en fibre de coco',
  '3760388679386': 'socle pour parasol coco',
};

export function buildStockHorsOctopiaBlock(items: { sku: string; name: string; qtyDemanded: string }[]): string {
  if (items.length === 0) return '';
  return `══════════════════════════════════════════════════════
📦 STOCK GÉRÉ HORS SYSTÈME — À DEMANDER AU GÉRANT

Le stock de ces produits n'est pas suivi automatiquement :
${items.map((i) => `  • SKU ${i.sku} | ${STOCK_HORS_OCTOPIA[i.sku] || i.name} | client demande : ${i.qtyDemanded}`).join('\n')}

TU DOIS :
1. Chiffrer normalement au tarif catalogue.
2. Demander en QUESTIONS (🟠) au gérant si la quantité demandée est disponible.
3. Dans le brouillon, n'annoncer AUCUNE quantité en stock, aucune rupture et aucun délai de réassort pour ces produits. La mention « sous réserve de disponibilité au moment de la validation de votre devis » reste valable.
══════════════════════════════════════════════════════`;
}
