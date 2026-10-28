/**
 * Normalisation du n° TVA intracommunautaire avant envoi à Pennylane.
 *
 * Pennylane (vérification VIES) exige le préfixe pays : « ESB26629626 », pas
 * « B26629626 ». Les clients donnent souvent leur numéro national seul (CIF
 * espagnol, partita IVA, USt-IdNr sans DE…) → 422 « VAT number is unregistered
 * or has invalid format ». Cas déclencheur cnv_1m5pll1z (RED, 28/10/2026).
 *
 * Copie côté plugin : client/src/utils/vatNumber.ts (garder les 2 alignées).
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
