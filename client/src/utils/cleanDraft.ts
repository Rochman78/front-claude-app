/**
 * Nettoie le brouillon final généré par Claude.
 * Supprime les préfixes d'étape, signatures, et formules de politesse en fin de mail.
 */
export function cleanDraft(text: string): string {
  let cleaned = text;

  // Supprimer tout avant "Bonjour" (étapes, titres, etc.)
  const bonjourIndex = cleaned.indexOf('Bonjour');
  if (bonjourIndex > 0) {
    cleaned = cleaned.substring(bonjourIndex);
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
