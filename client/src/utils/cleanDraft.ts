/**
 * Extrait UNIQUEMENT le brouillon mail depuis la réponse Claude.
 * Prend le texte de "Bonjour" jusqu'avant "QUESTIONS" (ou la fin si pas de questions).
 * Supprime les signatures et formules de politesse.
 */
export function cleanDraft(text: string): string {
  let cleaned = text;

  // Réponses "bavardes" : Claude produit parfois PLUSIEURS tentatives de brouillon
  // + du méta-commentaire ("Laissez-moi rédiger", "Voilà c'est propre"...), dont la
  // dernière peut être tronquée. On isole le DERNIER mail COMPLET (repéré par la
  // formule de clôture standard) et la salutation qui le précède.
  const closingRe = /N['’]?h[ée]sitez pas (?:à|a) nous contacter[^\n]*/gi;
  let lastClose: RegExpExecArray | null = null;
  let cm: RegExpExecArray | null;
  while ((cm = closingRe.exec(cleaned)) !== null) lastClose = cm;
  if (lastClose) {
    const closeEnd = lastClose.index + lastClose[0].length;
    const greets = ['Bonjour', 'Hallo', 'Hola', 'Buongiorno', 'Goedendag', 'Beste', 'Dear', 'Hello'];
    let gStart = -1;
    for (const g of greets) {
      const idx = cleaned.lastIndexOf(g, lastClose.index);
      if (idx > gStart) gStart = idx;
    }
    if (gStart >= 0) cleaned = cleaned.slice(gStart, closeEnd);
  }

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
  // ⚠️ VÉRIFICATION/VERIFICATION : MAJUSCULES STRICTES (pas de flag `i`) + \n final obligatoire,
  // sinon on coupe le mail quand Claude écrit "Vérification catalogue —..." comme intro de
  // paragraphe dans le brouillon (bug Teresa Almenara cnv_xxx 04/06/2026).
  const questionsPatterns = [
    /\n\**\s*VÉRIFICATION\s*\**\s*\n/,
    /\n\**\s*VERIFICATION\s*\**\s*\n/,
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

  // On ne supprime que les lignes COURTES (≤ 80 chars) contenant un mot banni —
  // typique d'une signature ("Cordialement,", "L'équipe X", "À votre disposition,").
  // Sinon une vraie phrase de contenu contenant au milieu "à votre disposition"
  // se ferait charcuter (bug observé).
  const lines = cleaned.split('\n');
  while (lines.length > 0) {
    const last = lines[lines.length - 1].trim();
    if (last === '') {
      lines.pop();
    } else if (last.length <= 80 && banned.some((b) => last.toLowerCase().includes(b.toLowerCase()))) {
      lines.pop();
    } else {
      break;
    }
  }

  // Normaliser la salutation : « Bonjour <n'importe quoi>, » → « Bonjour, »
  // Charles 07/07/2026 : Claude glisse parfois un identifiant/code/prénom
  // (« Bonjour CE.74E, », « Bonjour Ricarda, », « Bonjour CLG-XXX, »)
  // même quand le prompt l'interdit. Scrub garanti à la sortie du plugin.
  const greetRe = /^([ \t]*)(Bonjour|Hallo|Hola|Buongiorno|Goedendag|Beste|Bom dia|Buenos días|Dear|Hello|Hi)\b[^,\n]*,[ \t]*/im;
  return lines.join('\n').replace(greetRe, '$1$2,').trim();
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
