/**
 * Vérification d'un n° TVA intracommunautaire auprès de la VIES (registre
 * européen, API REST publique de la Commission, sans clé).
 *
 * Sans n° valide à la VIES, pas d'exonération LIC (art. 262 ter I CGI) : la
 * TVA du pays de livraison s'applique. Cas déclencheur cnv_1m5pll1z (RED,
 * 28/10/2026) : CIF ESB26629626 non inscrit à la VIES, devis émis à 0 %.
 */

import { normalizeVatNumber } from '@/lib/vatNumber';

export type ViesStatus = 'valid' | 'invalid' | 'unavailable';

export interface ViesResult {
  vatNumber: string;
  status: ViesStatus;
  /** Raison sociale déclarée (si la VIES la communique, sinon absente). */
  name?: string;
  /** Code VIES brut (VALID, INVALID, INVALID_INPUT, MS_UNAVAILABLE, TIMEOUT…). */
  code?: string;
}

const VIES_URL = 'https://ec.europa.eu/taxation_customs/vies/rest-api/ms';
const TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 60 * 60 * 1000;

// Cache mémoire 1 h : le formulaire revérifie au blur et à la génération.
const cache = new Map<string, { at: number; result: ViesResult }>();

/**
 * `invalid` = la VIES répond que le numéro n'existe pas (ou format refusé).
 * `unavailable` = service du pays membre indisponible, timeout, erreur réseau :
 * on ne conclut pas, le gérant vérifie à la main.
 */
export async function checkVies(raw: string, country?: string | null): Promise<ViesResult> {
  const vatNumber = normalizeVatNumber(raw, country);
  const prefix = vatNumber.slice(0, 2);
  const national = vatNumber.slice(2);
  if (!/^[A-Z]{2}$/.test(prefix) || !national) {
    return { vatNumber, status: 'invalid', code: 'INVALID_INPUT' };
  }

  const hit = cache.get(vatNumber);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.result;

  let result = await queryVies(vatNumber, prefix, national);
  // Service du pays saturé (MS_MAX_CONCURRENT_REQ) ou lent : une 2e tentative.
  if (result.status === 'unavailable') {
    await new Promise((r) => setTimeout(r, 1000));
    result = await queryVies(vatNumber, prefix, national);
  }

  console.log(`[vies] ${vatNumber} → ${result.status} (${result.code})`);
  // On ne garde en cache que les réponses définitives.
  if (result.status !== 'unavailable') cache.set(vatNumber, { at: Date.now(), result });
  return result;
}

async function queryVies(vatNumber: string, prefix: string, national: string): Promise<ViesResult> {
  let result: ViesResult;
  try {
    const res = await fetch(`${VIES_URL}/${prefix}/vat/${encodeURIComponent(national)}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      result = { vatNumber, status: 'unavailable', code: `HTTP_${res.status}` };
    } else {
      const data = await res.json() as { isValid?: boolean; userError?: string; name?: string };
      const code = data.userError || '';
      const name = data.name && data.name !== '---' ? data.name.trim() : undefined;
      if (data.isValid === true) result = { vatNumber, status: 'valid', name, code };
      else if (code === 'INVALID' || code === 'INVALID_INPUT') result = { vatNumber, status: 'invalid', code };
      else result = { vatNumber, status: 'unavailable', code };
    }
  } catch (err) {
    result = { vatNumber, status: 'unavailable', code: err instanceof Error ? err.name : 'ERROR' };
  }
  return result;
}
