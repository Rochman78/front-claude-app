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
 * Détecte si la réponse de Claude indique que le brouillon est validable
 * (pas de questions, ou "tu peux valider").
 */
export function isDraftReady(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes('pas de question') ||
    lower.includes('tu peux valider') ||
    lower.includes('tu peux l\'envoyer') ||
    lower.includes('prêt à être envoyé') ||
    lower.includes('brouillon est prêt')
  );
}
