/**
 * Parse un message Claude et le sépare en 4 sections distinctes :
 *
 *   { intro, draft, verification, questions }
 *
 * Format Claude typique — chaque section peut être annoncée par un titre
 * bare (`BROUILLON`), gras markdown (`**BROUILLON**`) OU header markdown
 * (`# BROUILLON`, `## BROUILLON`, …). Les 3 formes sont supportées, ce qui
 * évite une régression comme cnv_1lwmc8d3 (15/07/2026) où Claude est passé
 * de `**VÉRIFICATION**` à `## VÉRIFICATION` et où cleanDraft n'a pas coupé
 * → toute la section QUESTIONS était partie au client.
 *
 * intro         : tout ce qui précède le mail (ANALYSE, INVENTAIRE DU CROQUIS,
 *                 raisonnement). Rarement affiché.
 * draft         : le mail au client, de « Bonjour » jusqu'à VÉRIFICATION /
 *                 QUESTIONS / fin. C'est CE QUE LE CLIENT DOIT LIRE.
 * verification  : bloc VÉRIFICATION (stock, cohérence prix). Interne au gérant.
 * questions     : bloc QUESTIONS (🔴 BLOQUANT / 🟠 ATTENTION / 🟢 INFO).
 *                 Interne au gérant. NE JAMAIS LAISSER PARTIR AU CLIENT.
 */
export interface SplitMessage {
  intro: string;
  draft: string;
  verification: string;
  questions: string;
  /** `true` si le parser a trouvé un vrai marqueur brouillon et split proprement.
   *  `false` si aucun repère trouvé (message atypique) — on renvoie tout en draft
   *  et le rendu doit rester conservateur (afficher en mode legacy).  */
  hasStructure: boolean;
}

/** Regex fabricant : matche un titre section en début de ligne, avec
 *  tolérance pour les préfixes markdown (`#` H1-H6), les astérisques
 *  (`**`, `***`), les emojis et le suffixe optionnel « GÉRANT ».
 *  Renvoie une regex non-globale — la première occurrence suffit.  */
function sectionTitleRe(keywords: string[]): RegExp {
  const alt = keywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(
    // début de ligne / après \n, préfixe markdown facultatif (# ou *), le mot,
    // suffixe optionnel « GÉRANT » ou entre parenthèses, saut de ligne.
    `(^|\\n)\\s*(?:#{1,6}\\s*)?\\**\\s*(?:${alt})\\s*\\**\\s*(?:GÉRANT|GERANT)?\\s*(?:\\([^)]*\\))?\\s*(?:\\n|$)`,
    'i',
  );
}

const DRAFT_TITLES = ['BROUILLON', 'MAIL FINAL', 'DRAFT', 'ENTWURF', 'BORRADOR', 'BOZZA'];
const VERIFICATION_TITLES = ['VÉRIFICATION', 'VERIFICATION'];
const QUESTIONS_TITLES = ['QUESTIONS', 'QUESTION', 'PREGUNTAS', 'PREGUNTA', 'FRAGEN', 'VRAGEN', 'DOMANDE', 'PERGUNTAS', 'PERGUNTA'];

const DRAFT_RE = sectionTitleRe(DRAFT_TITLES);
const VERIFICATION_RE = sectionTitleRe(VERIFICATION_TITLES);
const QUESTIONS_RE = sectionTitleRe(QUESTIONS_TITLES);

/** Retire un séparateur horizontal markdown ( `---` / `___` / `***` ) en début/fin. */
function trimSeparators(s: string): string {
  return s
    .replace(/^\s*(?:[-_*]{3,}\s*\n)+/g, '')
    .replace(/(?:\n\s*[-_*]{3,}\s*)+\s*$/g, '')
    .trim();
}

/** Point d'entrée principal — pur, sans effet de bord. */
export function splitAssistantMessage(raw: string): SplitMessage {
  const text = raw || '';
  const draftMatch = DRAFT_RE.exec(text);

  if (!draftMatch) {
    // Pas de marqueur BROUILLON. Cas rétro-compat : ancienne version de Claude
    // qui écrivait juste « Bonjour, ... » sans le titre. On cherche alors les
    // sections VÉRIFICATION/QUESTIONS pour découper à partir de zéro.
    const vMatch = VERIFICATION_RE.exec(text);
    const qMatch = QUESTIONS_RE.exec(text);
    const cutIdx = [vMatch?.index, qMatch?.index]
      .filter((i): i is number => typeof i === 'number' && i >= 0)
      .sort((a, b) => a - b)[0];
    if (cutIdx === undefined) {
      return { intro: '', draft: text.trim(), verification: '', questions: '', hasStructure: false };
    }
    const draft = trimSeparators(text.slice(0, cutIdx));
    const rest = text.slice(cutIdx);
    return {
      intro: '',
      draft,
      verification: extractSection(rest, VERIFICATION_RE, [QUESTIONS_RE]),
      questions: extractSection(rest, QUESTIONS_RE, []),
      hasStructure: true,
    };
  }

  // Cas nominal : on a `## BROUILLON` (ou variantes). Tout ce qui précède
  // = intro (raisonnement interne).
  const draftStart = draftMatch.index + draftMatch[0].length;
  const intro = trimSeparators(text.slice(0, draftMatch.index));
  const afterDraft = text.slice(draftStart);

  // Chercher le premier VÉRIFICATION OU QUESTIONS après BROUILLON
  const vMatch = VERIFICATION_RE.exec(afterDraft);
  const qMatch = QUESTIONS_RE.exec(afterDraft);
  const nextCut = [vMatch?.index, qMatch?.index]
    .filter((i): i is number => typeof i === 'number' && i >= 0)
    .sort((a, b) => a - b)[0];

  const draftBody = nextCut === undefined ? afterDraft : afterDraft.slice(0, nextCut);
  const tail = nextCut === undefined ? '' : afterDraft.slice(nextCut);

  return {
    intro,
    draft: trimSeparators(draftBody),
    verification: extractSection(tail, VERIFICATION_RE, [QUESTIONS_RE]),
    questions: extractSection(tail, QUESTIONS_RE, []),
    hasStructure: true,
  };
}

/** Extrait la section démarrée par `startRe` dans `text`, jusqu'à la
 *  première section d'arrêt (`stopRes`) ou la fin du texte. */
function extractSection(text: string, startRe: RegExp, stopRes: RegExp[]): string {
  const m = startRe.exec(text);
  if (!m) return '';
  const start = m.index + m[0].length;
  const rest = text.slice(start);
  const stopIdx = stopRes
    .map((re) => re.exec(rest)?.index)
    .filter((i): i is number => typeof i === 'number' && i >= 0)
    .sort((a, b) => a - b)[0];
  const body = stopIdx === undefined ? rest : rest.slice(0, stopIdx);
  return trimSeparators(body);
}
