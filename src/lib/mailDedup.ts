/**
 * Dédupe les blocs longs répétés dans un fil de mails (signatures emails,
 * citations multi-niveau, mentions légales GDPR, etc.).
 *
 * Le contexte client peut contenir 5 répétitions de la même signature de
 * 1 500 caractères chacune (cas Suex S.r.l. 17/06/2026). Ce bruit sature
 * Claude et peut le faire dériver vers la langue dominante du contexte.
 *
 * Stratégie : pour chaque paragraphe long (≥ MIN_BLOCK_LEN), on calcule
 * une empreinte sur les 200 premiers caractères normalisés. Si cette
 * empreinte a déjà été vue, on remplace le paragraphe par un marqueur
 * court `[signature/citation déjà vue plus haut]`.
 *
 * On ne dédupe PAS les paragraphes courts (le contenu utile du mail) :
 * un seuil à 200 chars protège les phrases normales.
 */

const MIN_BLOCK_LEN = 200;
const FINGERPRINT_LEN = 200;

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

export function dedupeRepeatedBlocks(text: string): { cleaned: string; removed: number; bytesSaved: number } {
  if (!text || text.length < MIN_BLOCK_LEN * 2) {
    return { cleaned: text, removed: 0, bytesSaved: 0 };
  }

  // Découpage en paragraphes (séparés par ≥ 1 ligne vide)
  const paragraphs = text.split(/\n{2,}/);
  const seen = new Set<string>();
  const out: string[] = [];
  let removed = 0;
  let bytesSaved = 0;

  for (const p of paragraphs) {
    if (p.length < MIN_BLOCK_LEN) {
      out.push(p);
      continue;
    }
    const fp = normalize(p).slice(0, FINGERPRINT_LEN);
    if (seen.has(fp)) {
      out.push("[signature/citation déjà vue plus haut — voir ci-dessus]");
      removed += 1;
      bytesSaved += p.length;
      continue;
    }
    seen.add(fp);
    out.push(p);
  }

  return { cleaned: out.join("\n\n"), removed, bytesSaved };
}
