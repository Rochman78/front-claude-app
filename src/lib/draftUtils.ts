/**
 * Utilitaires pour la détection d'état du brouillon et le rendu markdown.
 */

/**
 * Détecte si le dernier message Claude signale que le brouillon est prêt (pas de questions).
 */
export function isDraftReady(content: string): boolean {
  const lower = content.toLowerCase();

  // Avec header "QUESTIONS :"
  const questionsMatch = content.match(/QUESTIONS?\s*:([^\n]*(?:\n(?!ÉTAPE|BROUILLON|##)[^\n]*)*)/i);
  if (questionsMatch) {
    const answer = questionsMatch[1].toLowerCase();
    if (/pas de question|aucune question|sans question|pas de questions particulière|aucune question particulière/.test(answer)) return true;
  }

  // Sans header — Claude dit directement "Pas de question supplémentaire"
  return /pas de question suppl|aucune question suppl|pas de questions suppl|tu valides ce brouillon/.test(lower);
}

/**
 * Convertit le markdown basique (gras, italique) en HTML pour l'affichage des messages Claude.
 */
export function renderMarkdown(text: string): { __html: string } {
  return {
    __html: text
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*\n]+)\*/g, '<em>$1</em>'),
  };
}
