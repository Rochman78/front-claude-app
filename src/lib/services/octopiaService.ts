/**
 * Service Octopia — consultation du stock par SKU (sellerProductReference).
 * Auth OAuth2 client_credentials avec cache token 2h.
 */

const AUTH_URL = 'https://auth.octopia-io.net/auth/realms/maas/protocol/openid-connect/token';
const API_BASE = 'https://api.octopia-io.net/seller/v2';

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

async function getToken(): Promise<string> {
  // Token encore valide (avec 5min de marge)
  if (cachedToken && Date.now() < tokenExpiresAt - 5 * 60 * 1000) {
    return cachedToken;
  }

  const clientId = process.env.OCTOPIA_CLIENT_ID;
  const clientSecret = process.env.OCTOPIA_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('OCTOPIA_CLIENT_ID ou OCTOPIA_CLIENT_SECRET manquant dans .env');
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await fetch(AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Octopia auth failed (${res.status}): ${err}`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in || 7200) * 1000;
  console.log(`[octopia] token obtained, expires in ${data.expires_in || 7200}s`);
  return cachedToken!;
}

/**
 * Récupère le stock disponible pour un SKU donné.
 * Retourne le nombre d'unités disponibles, ou null si SKU non trouvé.
 */
export async function getStockBySku(sku: string): Promise<number | null> {
  const sellerId = process.env.OCTOPIA_SELLER_ID;
  if (!sellerId) return null;

  try {
    const token = await getToken();
    const url = `${API_BASE}/stocks?sellerProductReference=${encodeURIComponent(sku)}&limit=10`;

    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        sellerId,
      },
    });

    if (!res.ok) {
      console.warn(`[octopia] stock query failed for ${sku}: ${res.status}`);
      return null;
    }

    const data = await res.json();
    const items = data.items || [];
    if (items.length === 0) return null;

    // Agréger le stock de tous les entrepôts
    let total = 0;
    for (const item of items) {
      total += item.quantities?.Available || 0;
    }

    console.log(`[octopia] stock ${sku}: ${total} available`);
    return total;
  } catch (err) {
    console.warn(`[octopia] stock error for ${sku}:`, err);
    return null;
  }
}

/**
 * Récupère le stock pour une liste de SKUs.
 * Retourne un Map { sku → quantité disponible }.
 * SKUs non trouvés sont omis.
 */
export async function getStockBySkuList(skus: string[]): Promise<Record<string, number>> {
  const result: Record<string, number> = {};

  for (const sku of skus) {
    const qty = await getStockBySku(sku);
    if (qty !== null) {
      result[sku] = qty;
    }
    // 500ms entre les appels pour respecter les quotas Octopia
    if (skus.indexOf(sku) < skus.length - 1) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  return result;
}

/**
 * Extrait les SKUs mentionnés dans un texte (codes EAN 13 chiffres commençant par 37).
 */
export function extractSkusFromText(text: string): string[] {
  const matches = text.match(/\b37[0-9]{11}\b/g) || [];
  return Array.from(new Set(matches));
}
