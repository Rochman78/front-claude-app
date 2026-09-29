/**
 * Calcul sur-mesure fait par le CODE, injecté dans le message d'analyse
 * (28/09/2026, étape 4 de l'audit des instructions).
 *
 * Le banc de rejeu a montré que les erreurs de prix sur-mesure viennent du
 * calcul laissé au modèle : Héron faux, surface non arrondie avant le total,
 * mauvaise tranche (6-10 au lieu de > 10), mauvaise ligne de grille. Ici :
 *   1. un pré-passage Claude (Sonnet 4.6) EXTRAIT seulement les données du fil
 *      (forme, côtés, diagonale, finition, ignifugé, couleur, quantité) en JSON ;
 *   2. le code calcule tout le reste de façon déterministe : arrondi des
 *      dimensions au dixième, surface (Héron, 2 triangles via la diagonale,
 *      trapèze), arrondi de la surface au dixième AVANT le total, surface
 *      totale, tranche, prix HT/m² lu dans prix-ht-sur-mesure.txt, totaux HT ;
 *   3. un filet dont la combinaison complète existe au catalogue standard est
 *      sorti du calcul (il sera chiffré au prix catalogue).
 * Un filet incomplet (côté ou diagonale manquant) est listé comme tel, sans prix.
 */
import { callClaude } from '@/lib/services/claudeService';

export type Forme = 'rectangle' | 'triangle' | 'trapeze' | 'quadrilatere';
export type Finition = 'polyester' | 'acier';

export interface FiletDemande {
  forme: Forme;
  cotes: number[];           // m — rectangle 2, triangle 3, quadrilatère 4 (haut, droite, bas, gauche)
  diagonale?: number | null; // m — quadrilatère : du coin haut-gauche au coin bas-droit
  bases?: number[] | null;   // m — trapèze : [grande base, petite base] (côtés parallèles)
  finition?: Finition | null;
  ignifuge?: boolean | null;
  couleur?: string | null;
  quantite?: number | null;
}

const TRANCHES = ['< 2 m²', '2-5 m²', '6-10 m²', '> 10 m²'];

// ─── grille ───────────────────────────────────────────────────────
type Grille = Map<string, number[]>; // clé « RECTANGLE|ACIER|0 » → 4 prix HT/m²

export function parseGrille(content: string): Grille {
  const g: Grille = new Map();
  const lines = content.split('\n');
  for (let i = 0; i < lines.length - 1; i++) {
    const h = lines[i].trim().match(/^(RECTANGLE|TRIANGLE-TRAPÈZE) \/ (POLYESTER|ACIER)( \/ IGNIFUGÉ)? :$/);
    if (!h) continue;
    const prices = Array.from(lines[i + 1].matchAll(/:\s*(\d+,\d{2})/g)).map((mm) => parseFloat(mm[1].replace(',', '.')));
    if (prices.length === 4) g.set(`${h[1]}|${h[2]}|${h[3] ? 1 : 0}`, prices);
  }
  return g;
}

export function trancheIndex(surfaceTotale: number): number {
  if (surfaceTotale < 2) return 0;
  if (surfaceTotale < 6) return 1;
  if (surfaceTotale < 10) return 2;
  return 3;
}

// ─── géométrie ────────────────────────────────────────────────────
/** Arrondi des DIMENSIONS au dixième, « ,x5 » vers le bas (exemple de la grille : 4,25 m → 4,2 m). */
export function dixieme(x: number): number {
  const c = Math.round(x * 1000); // millimètres, évite les erreurs flottantes
  const reste = c % 100;
  return (reste <= 50 ? c - reste : c - reste + 100) / 1000;
}

/** Arrondi des SURFACES au dixième le plus proche, « ,x5 » vers le haut
 *  (Charles 29/09/2026 : 4,5 × 4,5 = 20,25 m² → 20,3 m²). */
export function arrondiSurface(x: number): number {
  const c = Math.round(x * 1000);
  const reste = c % 100;
  return (reste < 50 ? c - reste : c - reste + 100) / 1000;
}

function heron(a: number, b: number, c: number): number | null {
  if (a + b <= c || a + c <= b || b + c <= a) return null;
  const s = (a + b + c) / 2;
  return Math.sqrt(s * (s - a) * (s - b) * (s - c));
}

interface SurfaceResult { brute: number | null; manque?: string; invalide?: string }

export function surface(f: FiletDemande): SurfaceResult {
  const c = f.cotes.map(dixieme);
  switch (f.forme) {
    case 'rectangle':
      return c.length === 2 ? { brute: c[0] * c[1] } : { brute: null, manque: '2 dimensions' };
    case 'triangle': {
      if (c.length !== 3) return { brute: null, manque: 'les 3 côtés' };
      const s = heron(c[0], c[1], c[2]);
      return s === null ? { brute: null, invalide: 'ces 3 côtés ne forment pas un triangle' } : { brute: s };
    }
    case 'trapeze': {
      const [B, b] = (f.bases || []).map(dixieme);
      // côtés latéraux = les 4 côtés moins une occurrence de chaque base
      const lat = [...c];
      for (const base of [B, b]) {
        const i = lat.indexOf(base);
        if (i >= 0) lat.splice(i, 1);
      }
      if (!B || !b || B === b || c.length !== 4 || lat.length !== 2) return { brute: null, manque: 'les 2 bases parallèles et les 2 côtés' };
      const t = heron(Math.abs(B - b), lat[0], lat[1]);
      if (t === null) return { brute: null, invalide: 'ces côtés ne forment pas un trapèze' };
      const h = (2 * t) / Math.abs(B - b);
      return { brute: ((B + b) / 2) * h };
    }
    case 'quadrilatere': {
      if (c.length !== 4) return { brute: null, manque: 'les 4 côtés + 1 diagonale' };
      if (!f.diagonale) return { brute: null, manque: '1 diagonale' };
      const d = dixieme(f.diagonale);
      const s1 = heron(c[0], c[1], d);
      const s2 = heron(c[2], c[3], d);
      if (s1 === null || s2 === null) return { brute: null, invalide: 'la diagonale est incompatible avec les côtés' };
      return { brute: s1 + s2 };
    }
  }
}

// ─── catalogue standard (sortie du calcul si la combinaison existe) ────────
const COULEURS: Record<string, string> = { beige: 'sable', arena: 'sable', sand: 'sable', kaki: 'militaire', khaki: 'militaire' };

function tailleKey(nums: number[]): string {
  return [...nums].sort((a, b) => a - b).map((n) => String(n)).join('x');
}

/** true si la combinaison forme + finition + couleur + taille existe en standard,
 *  « couleur ? » si la taille existe dans cette finition mais la couleur est inconnue. */
export function existeEnStandard(f: FiletDemande, standardsContent: string): boolean | 'couleur ?' {
  if (f.forme !== 'rectangle' && f.forme !== 'triangle') return false;
  const key = tailleKey(f.cotes.map(dixieme));
  const matiere = f.finition === 'acier' ? 'câble acier' : f.finition === 'polyester' ? 'polyester' : null;
  const couleur = f.couleur ? (COULEURS[f.couleur.toLowerCase()] || f.couleur.toLowerCase()) : null;
  let tailleSeule = false;
  for (const raw of standardsContent.split('\n')) {
    const p = raw.split('|').map((x) => x.trim().toLowerCase());
    if (p.length !== 19 || p[0] !== 'filet') continue;
    const formeOk = f.forme === 'triangle' ? p[1] === 'triangle' : p[1] === 'rectangle' || p[1] === 'carré';
    if (!formeOk) continue;
    const nums = p[4].replace(',', '.').split('x').map(Number);
    if (nums.some(isNaN) || tailleKey(nums) !== key) continue;
    if (matiere && p[2] !== matiere) continue;
    if (couleur && p[3] === couleur) return true;
    if (!couleur) tailleSeule = true;
  }
  return tailleSeule ? 'couleur ?' : false;
}

// ─── extraction (pré-passage) ─────────────────────────────────────
const EXTRACT_PROMPT = `Tu extrais d'un fil de mails SAV les FILETS SUR-MESURE (ou de taille non standard) que le CLIENT demande à chiffrer, avec leurs dimensions EXPLICITES. Tu ne calcules rien.

Règles :
- Uniquement des dimensions écrites par le client (texte, formulaire, ou croquis décrit dans le texte). Si le client a corrigé ses dimensions, prendre la DERNIÈRE version. Ne jamais inventer une dimension manquante.
- Convertir en mètres (520 cm → 5.2). Garder la précision donnée (4,83 m → 4.83).
- forme : "rectangle" (ou carré), "triangle" (3 côtés), "trapeze" (seulement si le client dit explicitement que 2 côtés sont parallèles), "quadrilatere" (4 côtés quelconques, ou « trapèze » sans parallélisme confirmé).
- cotes : rectangle [L, l] ; triangle [a, b, c] ; quadrilatère/trapèze les 4 côtés dans l'ordre haut, droite, bas, gauche (null pour un côté non coté).
- diagonale : longueur d'une diagonale si le client l'a donnée, sinon null.
- bases : trapèze uniquement, [grande base, petite base], sinon null.
- finition : "polyester" (corde / bordure polyester) ou "acier" (câble acier), null si non précisée.
- ignifuge : true / false / null. couleur : telle qu'écrite (sable, blanc, vert…) ou null. quantite : nombre de filets identiques (1 par défaut).
- Toiles / voiles / rideaux en fibre de COCO : NE PAS les lister (jamais de sur-mesure).
- Aucun filet à dimensions explicites → {"filets": []}.

Réponds UNIQUEMENT par un JSON : {"filets": [{"forme": "...", "cotes": [...], "diagonale": null, "bases": null, "finition": null, "ignifuge": null, "couleur": null, "quantite": 1}]}

FIL DE MAILS :
`;

export async function extraireFilets(mail: string): Promise<FiletDemande[]> {
  const raw = await callClaude(
    [{ role: 'user', content: EXTRACT_PROMPT + mail.substring(0, 12000) }],
    { model: 'claude-sonnet-4-6', maxTokens: 1500 }
  );
  const json = raw.match(/\{[\s\S]*\}/);
  if (!json) return [];
  try {
    const parsed = JSON.parse(json[0]) as { filets?: FiletDemande[] };
    return (parsed.filets || []).filter(
      (f) => f && ['rectangle', 'triangle', 'trapeze', 'quadrilatere'].includes(f.forme) && Array.isArray(f.cotes)
    );
  } catch {
    return [];
  }
}

// ─── bloc injecté ─────────────────────────────────────────────────
const eur = (n: number) => n.toFixed(2).replace('.', ',');
const m = (n: number) => String(Math.round(n * 1000) / 1000).replace('.', ',');

export function buildSurMesureBlock(filets: FiletDemande[], grilleContent: string, standardsContent: string): string {
  if (filets.length === 0) return '';
  const grille = parseGrille(grilleContent);
  if (grille.size === 0) return '';

  type Ligne = { f: FiletDemande; desc: string; surf?: number; qte: number; note?: string };
  const lignes: Ligne[] = filets.map((f) => {
    const cotes = (f.cotes || []).filter((x): x is number => typeof x === 'number' && x > 0);
    const f2 = { ...f, cotes };
    const qte = f.quantite && f.quantite > 0 ? Math.round(f.quantite) : 1;
    const changes = [...cotes, ...(f.diagonale ? [f.diagonale] : [])].filter((x) => dixieme(x) !== x);
    const arrondis = changes.length ? ` (arrondi au dixième : ${changes.map((x) => `${m(x)} → ${m(dixieme(x))}`).join(', ')})` : '';
    const desc = `${titre({ ...f, cotes })}${f.diagonale ? `, diagonale ${m(dixieme(f.diagonale))} m` : ''}` +
      `${f.finition ? `, ${f.finition === 'acier' ? 'câble acier' : 'polyester'}` : ''}${f.ignifuge ? ', ignifugé' : ''}${f.couleur ? `, ${f.couleur}` : ''} × ${qte}${arrondis}`;
    if (cotes.length !== f.cotes.length) return { f: f2, desc, qte, note: 'côté(s) non coté(s) → surface non calculable, demander la ou les cotes manquantes' };
    const std = existeEnStandard(f2, standardsContent);
    if (std === true) return { f: f2, desc, qte, note: 'EXISTE EN STANDARD CATALOGUE (même taille, finition, couleur) → chiffrer au prix catalogue, hors calcul sur-mesure' };
    const s = surface(f2);
    if (s.brute === null) return { f: f2, desc, qte, note: s.manque ? `surface non calculable : manque ${s.manque}` : `⚠️ ${s.invalide} — vérifier les cotes` };
    return { f: f2, desc, qte, surf: arrondiSurface(s.brute), note: std === 'couleur ?' ? 'cette taille existe en standard dans certaines couleurs : si la couleur demandée y est, chiffrer en standard' : undefined };
  });

  const calculables = lignes.filter((l) => l.surf !== undefined);
  const out: string[] = [];
  for (const l of lignes) {
    out.push(`  • ${l.desc}`);
    if (l.surf !== undefined) {
      const brute = surface(l.f).brute!;
      out.push(`      surface : ${m(Math.round(brute * 1000) / 1000)} m² → arrondie ${m(l.surf)} m²${l.qte > 1 ? ` × ${l.qte} = ${m(arrondiSurface(l.surf * l.qte))} m²` : ''}`);
    }
    if (l.note) out.push(`      ${l.note}`);
  }

  if (calculables.length > 0) {
    const totale = arrondiSurface(calculables.reduce((acc, l) => acc + l.surf! * l.qte, 0));
    const t = trancheIndex(totale);
    out.push('', `  Surface totale sur-mesure : ${m(totale)} m² → tranche « ${TRANCHES[t]} »`);
    let totalHT = 0;
    let complet = true;
    for (const l of calculables) {
      const famille = l.f.forme === 'rectangle' ? 'RECTANGLE' : 'TRIANGLE-TRAPÈZE';
      const finitions: Finition[] = l.f.finition ? [l.f.finition] : ['polyester', 'acier'];
      const parts = finitions.map((fin) => {
        const prix = grille.get(`${famille}|${fin === 'acier' ? 'ACIER' : 'POLYESTER'}|${l.f.ignifuge ? 1 : 0}`);
        if (!prix) return `${fin} : ligne de grille introuvable`;
        const pu = prix[t];
        const ligneHT = Math.round(l.surf! * pu * 100) / 100 * l.qte;
        if (finitions.length === 1) totalHT += ligneHT;
        return `${famille} / ${fin === 'acier' ? 'ACIER' : 'POLYESTER'}${l.f.ignifuge ? ' / IGNIFUGÉ' : ''} : ${eur(pu)} €/m² HT × ${m(l.surf!)} m² = ${eur(Math.round(l.surf! * pu * 100) / 100)} € HT${l.qte > 1 ? ` × ${l.qte} = ${eur(ligneHT)} € HT` : ''}`;
      });
      if (finitions.length > 1) complet = false;
      out.push(`  ${titre(l.f)}${finitions.length > 1 ? ' — finition NON précisée, les deux options :' : ''}`);
      parts.forEach((p) => out.push(`      ${p}`));
    }
    if (complet) out.push(`  TOTAL HT sur-mesure : ${eur(totalHT)} € (TVA à appliquer selon le pays de livraison)`);
    if (hasIncomplete(lignes)) out.push('  ⚠️ Des filets ne sont pas calculables : la tranche ci-dessus ne compte que les filets calculables et pourra changer une fois les cotes manquantes reçues.');
  }

  return `══════════════════════════════════════════════════════
📐 CALCUL SUR-MESURE FAIT PAR LE CODE (dimensions lues dans le fil, calcul déterministe)

${out.join('\n')}

Ces surfaces, tranche et prix au m² sont la SOURCE DE VÉRITÉ : recopie-les tels quels dans le brouillon, ne les recalcule pas. Si une dimension ci-dessus ne correspond pas à ce que le client a écrit (mauvaise lecture), ne chiffre pas : signale-le en QUESTIONS.
══════════════════════════════════════════════════════`;
}

function titre(f: FiletDemande): string {
  return `${f.forme} ${f.cotes.map((x) => m(dixieme(x))).join(' × ')} m`;
}

function hasIncomplete(lignes: { surf?: number; note?: string }[]): boolean {
  return lignes.some((l) => l.surf === undefined && !(l.note || '').startsWith('EXISTE EN STANDARD'));
}
