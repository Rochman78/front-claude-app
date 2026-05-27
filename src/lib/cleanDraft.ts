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
 * Extrait UNIQUEMENT le brouillon mail depuis la réponse Claude.
 * Version serveur, identique à client/src/utils/cleanDraft.ts : prend "Bonjour"
 * jusqu'avant QUESTIONS/VÉRIFICATION, retire commentaires [...] et signatures.
 * Utilisé par le brouillon automatique (auto-draft) pour ne JAMAIS envoyer de
 * notes internes (questions, alertes [⚠️...]) au client.
 */
export function cleanDraft(text: string): string {
  let cleaned = text;

  // Réponses "bavardes" : Claude produit parfois PLUSIEURS tentatives de brouillon
  // + du méta-commentaire ("Laissez-moi rédiger proprement", "Voilà c'est propre",
  // "Maintenant les questions"...), dont la dernière peut être tronquée.
  // On isole le DERNIER mail COMPLET, repéré par la formule de clôture standard,
  // et la salutation qui le précède → ignore le méta et les tentatives coupées.
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

  const draftMarkers = [/\bBROUILLON\b/i, /\bMAIL FINAL\b/i, /\bDRAFT\b/i, /\bENTWURF\b/i, /\bBORRADOR\b/i, /\bBOZZA\b/i];
  let markerEnd = -1;
  for (const marker of draftMarkers) {
    const match = cleaned.match(marker);
    if (match && match.index !== undefined) {
      markerEnd = match.index + match[0].length;
      break;
    }
  }

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

  const questionsPatterns = [
    /\n\**\s*VÉRIFICATION\s*\**/i,
    /\n\**\s*VERIFICATION\s*\**/i,
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

  cleaned = cleaned.replace(/\n[-—=]{2,}\s*$/, '');
  cleaned = cleaned.replace(/\n?\[[^\]]{3,}\]/g, '');

  const banned = [
    'Cordialement', 'Bien à vous', 'Bien cordialement',
    "L'équipe", 'Le service client', 'À votre disposition',
    'Belle journée', 'Bonne journée', 'Excellente journée',
    'Nous vous souhaitons', 'À bientôt',
    'Saludos cordiales', 'Atentamente', 'Un cordial saludo',
    'Mit freundlichen Grüßen', 'Freundliche Grüße', 'Beste Grüße',
    'Met vriendelijke groet', 'Hartelijke groet',
    'Cordiali saluti', 'Distinti saluti',
    'Atenciosamente', 'Cumprimentos',
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
 * Détecte si la réponse Claude contient des questions/points à vérifier en attente.
 */
export function hasOpenQuestions(text: string): boolean {
  if (/\bQUESTIONS?\s*\n/i.test(text)) return true;
  if (/\bVÉRIFICATION\b/i.test(text)) return true;
  if (/\[⚠️/.test(text)) return true;
  const afterBonjour = text.indexOf('Bonjour');
  const bodyAfterDraft = afterBonjour >= 0 ? text.substring(afterBonjour) : text;
  if (/\n\d+\.\s+.+\?/.test(bodyAfterDraft)) return true;
  return false;
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
