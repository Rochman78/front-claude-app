/**
 * Bloc « 🧾 N° TVA INTRA » injecté dans l'analyse (28/10/2026).
 *
 * Le code relève les n° de TVA intracommunautaire (hors France) cités dans le
 * fil, les vérifie à la VIES et donne le résultat à l'agent : sans n° valide,
 * pas de TVA 0 %. Cas déclencheur cnv_1m5pll1z (RED) : l'agent a annoncé une
 * TVA à 0 % sur le CIF ESB26629626, absent de la VIES.
 *
 * Les n° français sont ignorés : ils ne changent pas la TVA (et nos propres
 * n° FR figurent dans nos signatures).
 */
import { normalizeVatNumber } from '@/lib/vatNumber';
import { checkVies, type ViesResult } from '@/lib/services/viesService';

/** Format du n° national (après le préfixe) par préfixe TVA, d'après la VIES. */
const VAT_FORMATS: Record<string, RegExp> = {
  AT: /^U\d{8}$/, BE: /^[01]\d{9}$/, BG: /^\d{9,10}$/, CY: /^\d{8}[A-Z]$/, CZ: /^\d{8,10}$/,
  DE: /^\d{9}$/, DK: /^\d{8}$/, EE: /^\d{9}$/, EL: /^\d{9}$/,
  // ES : toujours au moins une lettre (CIF B26629626, NIE X…, DNI …L) — 9 chiffres seuls = n° portugais.
  ES: /^(?=.*[A-Z])[A-Z0-9]\d{7}[A-Z0-9]$/,
  FI: /^\d{8}$/, HR: /^\d{11}$/, HU: /^\d{8}$/, IE: /^(\d{7}[A-W][A-I]?|\d[A-Z+*]\d{5}[A-W])$/,
  IT: /^\d{11}$/, LT: /^(\d{9}|\d{12})$/, LU: /^\d{8}$/, LV: /^\d{11}$/, MT: /^\d{8}$/,
  NL: /^\d{9}B\d{2}$/, PL: /^\d{10}$/, PT: /^\d{9}$/, RO: /^\d{2,10}$/, SE: /^\d{10}01$/,
  SI: /^\d{8}$/, SK: /^\d{10}$/,
};

/** Pays de la boutique, utilisé quand le client écrit « TVA / VAT / IVA : 12345678901 » sans préfixe. */
const STORE_COUNTRY: Record<string, string> = {
  LFC: 'FR', LVO: 'FR', COCO: 'FR', MON: 'FR', UNI: 'FR',
  TAR: 'DE', HET: 'NL', RED: 'ES', REDE: 'PT', RETE: 'IT',
};

/** Groupe de caractères d'un n° : chaque morceau contient au moins un chiffre (« 8199.78.632.B01 »). */
const NUM = String.raw`[0-9A-Z]*\d[0-9A-Z]*(?:[ .\-][0-9A-Z]*\d[0-9A-Z]*)*`;

/** N° précédé de son préfixe pays : « ESB26629626 », « IT 01520200559 », « NL8199.78.632.B01 ». */
const PREFIXED_RE = new RegExp(String.raw`\b(${Object.keys(VAT_FORMATS).join('|')})[ .\-]?(${NUM})`, 'g');

/** Mots-clés suivis d'un n° national sans préfixe, avec le(s) pays à essayer. */
const KEYWORDS: { re: RegExp; countries: (store: string) => string[] }[] = [
  { re: /partita\s+iva|p\.\s?iva\b/gi, countries: () => ['IT'] },
  { re: /\bc\.?i\.?f\.?(?=[\s:.°nN])/gi, countries: () => ['ES'] },
  { re: /\bn\.?i\.?f\.?(?=[\s:.°nN])|\bnipc\b/gi, countries: (s) => (s === 'REDE' ? ['PT', 'ES'] : ['ES', 'PT']) },
  { re: /ust[\s.\-]*id(?:[\s.\-]*nr)?|umsatzsteuer[\s-]*(?:identifikations)?(?:nummer|id)/gi, countries: () => ['DE', 'AT'] },
  { re: /\bbtw\b/gi, countries: () => ['NL', 'BE'] },
  // « IVA » sert en Espagne, au Portugal et en Italie : formulaires RED remplis par des Portugais.
  { re: /\biva\b/gi, countries: (s) => Array.from(new Set([STORE_COUNTRY[s] || 'FR', 'ES', 'PT', 'IT'])) },
  { re: /\b(?:tva|vat|mwst|nip|uid)\b/gi, countries: (s) => [STORE_COUNTRY[s] || 'FR'] },
];

/** Mot-clé TVA juste avant un n° préfixé séparé par des espaces (« Ust-ID: DE 200 902 657 »). */
const ANY_KEYWORD_RE = /partita\s+iva|p\.\s?iva|c\.?i\.?f|n\.?i\.?f|nipc|ust[\s.\-]*id|umsatzsteuer|btw|tva|vat|iva|mwst|nip|uid/i;

/** N° complet (préfixe + national) s'il respecte le format de son pays, sinon null.
 *  Exclut les exemples (« DE123456789 » dans nos propres mails). */
function asValidFormat(raw: string, country: string): string | null {
  const vat = normalizeVatNumber(raw, country);
  const prefix = vat.slice(0, 2);
  const national = vat.slice(2);
  const format = VAT_FORMATS[prefix];
  if (!format || !format.test(national)) return null;
  if (/1234567|(\d)\1{6}/.test(national)) return null;
  return vat;
}

/** N° de TVA intra hors France cités dans le texte (format du pays respecté), dans l'ordre d'apparition. */
export function findVatNumbers(text: string, storeCode: string): string[] {
  const found: { at: number; vat: string }[] = [];

  for (const m of Array.from(text.matchAll(PREFIXED_RE))) {
    // Écrit avec des espaces (« PT 282 464 972 ») : souvent un téléphone →
    // accepté seulement derrière un mot-clé TVA.
    const at = m.index ?? 0;
    if (/\s/.test(m[0]) && !ANY_KEYWORD_RE.test(text.slice(Math.max(0, at - 40), at))) continue;
    const vat = asValidFormat(`${m[1]}${m[2]}`, m[1]);
    if (vat) found.push({ at, vat });
  }

  for (const { re, countries } of KEYWORDS) {
    for (const m of Array.from(text.matchAll(re))) {
      const start = (m.index ?? 0) + m[0].length;
      const after = text.slice(start, start + 50).toUpperCase();
      const num = after.match(new RegExp(NUM));
      // Le n° doit suivre de près le mot-clé (« CIF: B266… », « P.IVA n. 0152… »).
      if (!num || (num.index ?? 0) > 25) continue;
      for (const country of countries(storeCode)) {
        const vat = asValidFormat(num[0], country);
        if (vat) { found.push({ at: m.index ?? 0, vat }); break; }
      }
    }
  }

  const seen = new Set<string>();
  return found
    .sort((a, b) => a.at - b.at)
    .map((f) => f.vat)
    .filter((vat) => !vat.startsWith('FR') && !seen.has(vat) && !!seen.add(vat));
}

function formatLine(r: ViesResult): string {
  if (r.status === 'valid') return `  • ${r.vatNumber} → ✓ VALIDE${r.name ? ` (${r.name})` : ''}`;
  if (r.status === 'invalid') return `  • ${r.vatNumber} → ✗ ABSENT DE LA VIES (société non inscrite aux opérations intracommunautaires)`;
  return `  • ${r.vatNumber} → ⚠ VIES INDISPONIBLE (n° non vérifié)`;
}

/** Bloc à injecter, ou '' si aucun n° de TVA intra hors France dans le fil. 3 n° au plus. */
export async function buildVatFactsBlock(text: string, storeCode: string): Promise<string> {
  const vats = findVatNumbers(text, storeCode).slice(0, 3);
  if (vats.length === 0) return '';
  const results = await Promise.all(vats.map((v) => checkVies(v)));
  return `══════════════════════════════════════════════════════
🧾 N° TVA INTRACOMMUNAUTAIRE — VÉRIFIÉ À LA VIES PAR LE CODE

${results.map(formatLine).join('\n')}

✓ VALIDE : le n° ouvre droit au régime intracommunautaire, applique la règle B2B intracommunautaire (§6). N'en parle pas au client et ne pose pas de question au gérant à ce sujet.
✗ ABSENT : pas de TVA 0 %, jamais. TVA du pays de livraison, comme pour un client sans n°. Si le brouillon chiffre ou annonce une TVA, ajoute une phrase : « Votre numéro de TVA intracommunautaire n'apparaît pas dans le registre européen VIES : la TVA de votre pays (X %) s'applique donc. Si vous disposez d'un numéro valide, il vous suffit de nous le transmettre. » Sinon (facture, paiement, livraison, suivi), rien dans le brouillon. Dans tous les cas, signale-le en 🟠 dans QUESTIONS.
⚠ INDISPONIBLE : règles TVA habituelles, et signale en 🟠 que le n° est à vérifier avant le devis.
Le relevé est automatique : un n° qui n'est visiblement pas celui du client (téléphone, exemple, n° d'un fournisseur ou d'un tiers) s'ignore.
══════════════════════════════════════════════════════`;
}
