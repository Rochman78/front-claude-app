/**
 * Convertit du texte brut en HTML pour l'API createDraft de Front App.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function textToHtml(text: string): string {
  return text
    .split('\n')
    .map((line) => (line.trim() === '' ? '<br>' : `<p>${escapeHtml(line)}</p>`))
    .join('');
}
