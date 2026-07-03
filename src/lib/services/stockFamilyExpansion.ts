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
