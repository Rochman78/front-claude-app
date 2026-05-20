/**
 * Extrait UNIQUEMENT le brouillon mail depuis la réponse Claude.
 * Prend le texte de "Bonjour" jusqu'avant "QUESTIONS" (ou la fin si pas de questions).
 * Supprime les signatures et formules de politesse.
 */
export function cleanDraft(text: string): string {
  let cleaned = text;

  // Chercher le marqueur de brouillon (BROUILLON, MAIL FINAL, etc.) et prendre le "Bonjour" après
  const draftMarkers = [/\bBROUILLON\b/i, /\bMAIL FINAL\b/i, /\bDRAFT\b/i, /\bENTWURF\b/i, /\bBORRADOR\b/i, /\bBOZZA\b/i];
  let markerEnd = -1;
  for (const marker of draftMarkers) {
    const match = cleaned.match(marker);
    if (match && match.index !== undefined) {
      markerEnd = match.index + match[0].length;
      break;
    }
  }

  // Trouver "Bonjour" (ou équivalents) après le marqueur
  const greetings = ['Bonjour', 'Hallo', 'Hola', 'Buongiorno', 'Goedendag', 'Beste', 'Dear', 'Hello', 'Hi '];
  const searchFrom = markerEnd > 0 ? markerEnd : 0;
  let bonjourIndex = -1;
  for (const greeting of greetings) {
    const idx = cleaned.indexOf(greeting, searchFrom);
    if (idx >= 0 && (bonjourIndex < 0 || idx < bonjourIndex)) {
      bonjourIndex = idx;
    }
  }
  if (bonjourIndex > 0) {
    cleaned = cleaned.substring(bonjourIndex);
  }

  // Couper avant VÉRIFICATION ou QUESTIONS (toutes langues, avec ou sans formatage markdown)
  const questionsPatterns = [
    /\n\**\s*VÉRIFICATION\s*\**\s*\n/i,
    /\n\**\s*VERIFICATION\s*\**\s*\n/i,
    /\n\**\s*QUESTIONS?\s*\**\s*\n/i,
    /\n\**\s*PREGUNTAS?\s*\**\s*\n/i,
    /\n\**\s*FRAGEN\s*\**\s*\n/i,
    /\n\**\s*VRAGEN\s*\**\s*\n/i,
    /\n\**\s*DOMANDE\s*\**\s*\n/i,
    /\n\**\s*PERGUNTAS?\s*\**\s*\n/i,
    /\nPas de question/i,
    /\nTu peux valider/i,
    /\nSin preguntas/i,
    /\nKeine Fragen/i,
    /\nGeen vragen/i,
    /\nNessuna domanda/i,
    /\n\d+\.\s*\[⚠️/,
    /\nStock vérifié/i,
  ];
  for (const pattern of questionsPatterns) {
    const match = cleaned.match(pattern);
    if (match && match.index !== undefined) {
      cleaned = cleaned.substring(0, match.index);
      break;
    }
  }

  // Supprimer les séparateurs résiduels en fin de texte
  cleaned = cleaned.replace(/\n[-—=]{2,}\s*$/, '');

  // Supprimer TOUT ce qui est entre crochets [...] (commentaires internes de l'agent)
  cleaned = cleaned.replace(/\n?\[[^\]]{3,}\]/g, '');

  // Supprimer les signatures et formules de politesse en fin de mail (toutes langues)
  const banned = [
    'Cordialement', 'Bien à vous', 'Bien cordialement',
    "L'équipe", 'Le service client', 'À votre disposition',
    'Belle journée', 'Bonne journée', 'Excellente journée',
    'Nous vous souhaitons', 'À bientôt',
    // ES
    'Saludos cordiales', 'Atentamente', 'Un cordial saludo',
    // DE
    'Mit freundlichen Grüßen', 'Freundliche Grüße', 'Beste Grüße',
    // NL
    'Met vriendelijke groet', 'Hartelijke groet',
    // IT
    'Cordiali saluti', 'Distinti saluti',
    // PT
    'Atenciosamente', 'Cumprimentos',
    // EN
    'Best regards', 'Kind regards', 'Sincerely',
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
