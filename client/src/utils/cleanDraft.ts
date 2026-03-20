/**
 * Extrait UNIQUEMENT le brouillon mail depuis la réponse Claude.
 * Prend le texte de "Bonjour" jusqu'avant "QUESTIONS" (ou la fin si pas de questions).
 * Supprime les signatures et formules de politesse.
 */
export function cleanDraft(text: string): string {
  let cleaned = text;

  // Supprimer tout avant "Bonjour" (titres BROUILLON, etc.)
  const bonjourIndex = cleaned.indexOf('Bonjour');
  if (bonjourIndex > 0) {
    cleaned = cleaned.substring(bonjourIndex);
  }

  // Couper avant la section QUESTIONS (si elle existe)
  const questionsPatterns = [
    /\nQUESTIONS?\s*\n/i,
    /\nPas de question/i,
    /\nTu peux valider/i,
  ];
  for (const pattern of questionsPatterns) {
    const match = cleaned.match(pattern);
    if (match && match.index !== undefined) {
      cleaned = cleaned.substring(0, match.index);
      break;
    }
  }

  // Supprimer les signatures et formules de politesse en fin de mail
  const banned = [
    'Cordialement', 'Bien à vous', 'Bien cordialement',
    "L'équipe", 'Le service client', 'À votre disposition',
    'Belle journée', 'Bonne journée', 'Excellente journée',
    'Nous vous souhaitons', 'À bientôt',
  ];

  const lines = cleaned.split('\n');
  while (lines.length > 0) {
    const last = lines[lines.length - 1].trim();
    if (last === '' || banned.some((b) => last.toLowerCase().includes(b.toLowerCase()))) {
      lines.pop();
    } else {
      break;
    }
  }

  return lines.join('\n').trim();
}

/**
 * Détecte si le dernier message Claude contient des questions en attente.
 * Cherche : section "QUESTIONS", questions numérotées (1. 2. 3.), ou "?" en fin de phrase.
 */
export function hasOpenQuestions(text: string): boolean {
  // Section QUESTIONS explicite
  if (/\bQUESTIONS?\s*\n/i.test(text)) return true;

  // Questions numérotées après le brouillon (1. ... ? ou 2. ... ?)
  const afterBonjour = text.indexOf('Bonjour');
  const bodyAfterDraft = afterBonjour >= 0 ? text.substring(afterBonjour) : text;
  if (/\n\d+\.\s+.+\?/.test(bodyAfterDraft)) return true;

  return false;
}

/**
 * Détecte si la réponse de Claude indique que le brouillon est validable.
 * STRICT : retourne true UNIQUEMENT si Claude dit explicitement que c'est prêt
 * ET qu'il n'y a PAS de questions en attente.
 */
export function isDraftReady(text: string): boolean {
  // Si des questions sont détectées → jamais prêt automatiquement
  if (hasOpenQuestions(text)) return false;

  const lower = text.toLowerCase();
  return (
    lower.includes('pas de question') ||
    lower.includes('tu peux valider') ||
    lower.includes('tu peux l\'envoyer') ||
    lower.includes('prêt à être envoyé') ||
    lower.includes('brouillon est prêt')
  );
}
