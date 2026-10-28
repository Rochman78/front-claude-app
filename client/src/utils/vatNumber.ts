/**
 * Normalisation du n° TVA intracommunautaire avant envoi à Pennylane.
 *
 * Pennylane (vérification VIES) exige le préfixe pays : « ESB26629626 », pas
 * « B26629626 ». Les clients donnent souvent leur numéro national seul (CIF
 * espagnol, partita IVA, USt-IdNr sans DE…) → 422 « VAT number is unregistered
 * or has invalid format ». Cas déclencheur cnv_1m5pll1z (RED, 28/10/2026).
 *
 * Copie côté serveur : src/lib/vatNumber.ts (garder les 2 alignées).
 */

/** Préfixes TVA intra des 27 pays UE (la Grèce utilise EL, pas GR). */
const EU_VAT_PREFIXES = [
  'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'EL', 'ES', 'FI', 'FR', 'HR', 'HU',
  'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK',
];

/** Préfixe TVA d'un pays (code ISO alpha-2), ou null hors UE. */
function vatPrefixForCountry(country: string | undefined | null): string | null {
  const c = String(country || '').toUpperCase().trim();
  const prefix = c === 'GR' ? 'EL' : c;
  return EU_VAT_PREFIXES.includes(prefix) ? prefix : null;
}

/**
 * Retire espaces / points / tirets, met en majuscules et ajoute le préfixe du
 * pays de facturation s'il manque. Hors UE (Suisse, Royaume-Uni…) ou pays
 * inconnu : numéro nettoyé, sans préfixe ajouté.
 */
export function normalizeVatNumber(raw: string | undefined | null, country?: string | null): string {
  const s = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!s) return '';
  if (EU_VAT_PREFIXES.includes(s.slice(0, 2))) return s;
  if (s.startsWith('GR')) return `EL${s.slice(2)}`;
  const prefix = vatPrefixForCountry(country);
  return prefix ? `${prefix}${s}` : s;
}

/** Taux normaux UE 2026 par code pays ISO (GR, pas EL). FR inclus. */
export const EU_STANDARD_VAT_RATES: Record<string, number> = {
  AT: 20, BE: 21, BG: 20, CY: 19, CZ: 21, DE: 19, DK: 25, EE: 24, ES: 21,
  FI: 25.5, FR: 20, GR: 24, HR: 25, HU: 27, IE: 23, IT: 22, LT: 21, LU: 17,
  LV: 21, MT: 18, NL: 21, PL: 23, PT: 23, RO: 21, SE: 25, SI: 22, SK: 23,
};

/** Code pays ISO depuis le préfixe d'un n° TVA intra normalisé (EL → GR), ou null hors UE. */
export function countryFromVatNumber(vatNumber: string | undefined | null): string | null {
  const prefix = String(vatNumber || '').slice(0, 2).toUpperCase();
  if (!EU_VAT_PREFIXES.includes(prefix)) return null;
  return prefix === 'EL' ? 'GR' : prefix;
}
