/**
 * Convertit du texte brut en HTML pour createDraft de Front App.
 *
 * Logique :
 * - Les blocs séparés par une ligne vide → chacun dans un <p>
 * - Les sauts de ligne simples dans un même bloc → <br>
 * - Les lignes vides = séparateur de paragraphes (pas de <br> vide)
 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function textToHtml(text: string): string {
  // Découper en paragraphes : séparés par une ou plusieurs lignes vides
  const paragraphs = text.split(/\n\s*\n/);

  return paragraphs
    .map((block) => {
      const trimmed = block.trim();
      if (!trimmed) return '';

      // Dans chaque paragraphe, les sauts de ligne simples deviennent <br>
      const html = trimmed
        .split('\n')
        .map((line) => escapeHtml(line.trimEnd()))
        .join('<br>');

      return `<p>${html}</p>`;
    })
    .filter(Boolean)
    .join('');
}
