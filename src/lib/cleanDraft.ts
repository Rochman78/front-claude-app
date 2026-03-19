/**
 * Nettoyage des brouillons générés par Claude.
 * Extrait le corps du mail depuis la réponse structurée de Claude (analyse + brouillon + questions).
 */

/**
 * Extrait le brouillon email depuis la réponse complète de Claude.
 * Gère les différents formats : section BROUILLON, ÉTAPE 3, analyse en tête.
 */
export function cleanDraftContent(raw: string): string {
  // Si Claude a inclus une section BROUILLON DE RÉPONSE, extraire uniquement cette partie
  const brouillonMatch = raw.match(/\*?\*?BROUILLON\s+DE\s+R[EÉ]PONSE\s*:?\*?\*?\s*\n+([\s\S]+)/i);
  if (brouillonMatch) return brouillonMatch[1].trim();

  // Si le message est identifié comme mail final (étape 3), couper tout avant "Bonjour"
  const isFinalEmail = /[EÉ]TAPE\s*3|MAIL\s+FINAL|R[EÉ]PONSE\s+FINALE/i.test(raw);
  if (isFinalEmail) {
    const bonjourIdx = raw.search(/bonjour/i);
    if (bonjourIdx !== -1) return raw.slice(bonjourIdx).trim();
  }

  // Supprimer section d'analyse en tête si présente
  const analyseMatch = raw.match(/\*?\*?[A-ZÀÉÈÊ\s]+:?\*?\*?[\s\S]*?\n\n([\s\S]+)/);
  if (analyseMatch && /^(bonjour|chère|cher|madame|monsieur|hello)/i.test(analyseMatch[1])) {
    return analyseMatch[1].trim();
  }

  return raw.trim();
}

/**
 * Nettoie le brouillon final avant envoi vers Front App.
 * Supprime les marqueurs d'étape et les signatures auto-générées par Claude.
 */
export function cleanDraftResponse(text: string): string {
  let result = text;

  // 1. Si mail final, supprimer tout ce qui précède "Bonjour"
  const isFinalEmail = /[EÉ]TAPE\s*3|MAIL\s+FINAL|R[EÉ]PONSE\s+FINALE/i.test(result);
  if (isFinalEmail) {
    const idx = result.search(/bonjour/i);
    if (idx !== -1) result = result.slice(idx);
  }

  // 2. Supprimer la ligne de signature et les lignes vides qui suivent
  const sigPattern = /\n[^\n]*(cordialement|bien à vous|bien cordialement|l'équipe|le service client|à votre disposition|belle journée|bonne journée|excellente journée|nous vous souhaitons|à bientôt)[^\n]*(\n\s*)*/i;
  result = result.replace(sigPattern, '');

  return result.trim();
}
