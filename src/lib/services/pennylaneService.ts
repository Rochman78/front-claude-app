/**
 * Service Pennylane — centralise la logique de création de devis.
 */

import { getStoreByInboxName } from '@/lib/stores';

const PENNYLANE_API_URL = 'https://app.pennylane.com/api/external/v2';

const PRODUCT_ID_FILET   = 14369303;
// PRODUCT_ID_GENERIC retiré — les lignes accessoires/transport n'utilisent plus de product_id

function pennylaneHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${process.env.PENNYLANE_API_TOKEN}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

function getTemplateId(inboxName: string): number {
  const store = getStoreByInboxName(inboxName);
  return store?.pennylaneTemplateId || 253634; // fallback LFC
}

export async function findCustomerByEmail(email: string): Promise<{ id: string; type: string } | null> {
  try {
    const t0 = Date.now();
    const res = await fetch(
      `${PENNYLANE_API_URL}/customers?filter=${encodeURIComponent(JSON.stringify([{ field: 'emails', operator: 'in', value: [email] }]))}`,
      { headers: pennylaneHeaders() }
    );
    console.log(`[pennylane] findCustomer ${email} → ${res.status} (${Date.now() - t0}ms)`);
    if (res.ok) {
      const data = await res.json();
      const items = data.items || [];
      if (items.length > 0) {
        const customer = items[0];
        // Pennylane : customer_type = 'individual' ou 'company'
        const type = customer.customer_type || (customer.name ? 'company' : 'individual');
        console.log(`[pennylane] found customer ${customer.id} type=${type}`);
        return { id: customer.id, type };
      }
    }
  } catch { /* ignore */ }
  return null;
}

/** Convertit une adresse plugin (street/zipCode/city/country) au format Pennylane. */
function toPennylaneAddress(a: Record<string, string> | undefined | null): Record<string, string> | null {
  if (!a || !Object.values(a).some(Boolean)) return null;
  return {
    address: a.street || '',
    postal_code: a.zipCode || '',
    city: a.city || '',
    country_alpha2: a.country || 'FR',
  };
}

export async function createCustomer(customer: Record<string, unknown>): Promise<{ id?: string; error?: string }> {
  const type = (customer.type as string) || 'individual';
  const payload: Record<string, unknown> = {};

  if (customer.email) payload.emails = [customer.email];
  if (customer.phone) payload.phone = customer.phone;

  const billing = toPennylaneAddress(customer.address as Record<string, string> | undefined);
  if (billing) payload.billing_address = billing;

  // Adresse de livraison distincte — envoyée à Pennylane comme delivery_address
  // sur le customer, apparaît sur le PDF sous le bloc "Livrer à" (02/07/2026).
  const delivery = toPennylaneAddress(customer.deliveryAddress as Record<string, string> | undefined);
  if (delivery) payload.delivery_address = delivery;

  let endpoint: string;
  if (type === 'company') {
    endpoint = `${PENNYLANE_API_URL}/company_customers`;
    payload.name = customer.name || '';
    if (customer.vatNumber) payload.vat_number = customer.vatNumber;
  } else {
    endpoint = `${PENNYLANE_API_URL}/individual_customers`;
    payload.first_name = customer.firstName || '';
    payload.last_name = customer.lastName || '';
  }

  console.log(`[pennylane] createCustomer type=${type} email=${customer.email} payload:`, JSON.stringify(payload));

  const t0 = Date.now();
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: pennylaneHeaders(),
    body: JSON.stringify(payload),
  });
  console.log(`[pennylane] createCustomer → ${res.status} (${Date.now() - t0}ms)`);

  if (res.status === 200 || res.status === 201) {
    const result = await res.json();

    // Pour les company, ajouter le destinataire (nom du contact)
    if (type === 'company' && result.id && (customer.firstName || customer.lastName)) {
      const contactName = [customer.firstName, customer.lastName].filter(Boolean).join(' ');
      const updateRes = await fetch(`${PENNYLANE_API_URL}/company_customers/${result.id}`, {
        method: 'PUT',
        headers: pennylaneHeaders(),
        body: JSON.stringify({ recipient: contactName }),
      });
      console.log(`[pennylane] set recipient="${contactName}" → ${updateRes.status}`);
    }

    return result;
  }
  const text = await res.text();
  return { error: `Erreur création client: ${text}` };
}

export interface QuoteLine {
  type?: string;
  label?: string;
  quantity?: number;
  unitPrice?: number;
  vatRate?: string;
  description?: string;
  unit?: string;
}

export interface CreateQuoteParams {
  customer?: Record<string, unknown>;
  customerId?: string;
  lines: QuoteLine[];
  subject?: string;
  deadline?: string;
  freeText?: string;
  discountPercent?: number;
  inboxName?: string;
}

/**
 * Normalise un code TVA vers le format attendu par Pennylane : `XX_NNN`
 * où XX = code pays alpha-2 (UPPERCASE) et NNN = taux × 10 (entier).
 *
 * Pennylane est très strict et renvoie une erreur générique trompeuse
 * ("The schema of the object invoice_lines isn't one of the following...")
 * dès qu'un seul code TVA est invalide. On normalise donc agressivement.
 *
 * Cas acceptés :
 *   - "FR_200", "fr_200" → "FR_200"  (déjà au format, uppercased)
 *   - "exempt", "tax_free", "tax_free_0", "0", 0, null → "exempt"
 *   - 20, "20", "20.0", "20%" → "{fallbackCountry}_200"
 *   - "FR_20", "FR_TVA_20", "France_200" → tente extraction, sinon throw
 */
export function normalizeVatRate(raw: unknown, fallbackCountry: string = 'FR'): string {
  // Cas exempt
  if (raw === null || raw === undefined || raw === '' || raw === 0 || raw === '0') return 'exempt';
  const s = String(raw).trim();
  if (!s) return 'exempt';
  const lower = s.toLowerCase();
  if (lower === 'exempt' || lower === 'tax_free' || lower === 'tax_free_0' || lower === 'none') {
    return 'exempt';
  }
  // Format Pennylane natif : 2 lettres + _ + chiffres
  const native = s.match(/^([a-z]{2})_(\d+)$/i);
  if (native) return `${native[1].toUpperCase()}_${native[2]}`;
  // Format dégradé : extraire 2 lettres consécutives (pays) et le 1er nombre
  // ex : "FR_TVA_20", "France_200" → pays trouvé via prefix 2 lettres
  const country = (s.match(/^([a-z]{2})/i)?.[1] || fallbackCountry).toUpperCase();
  const numMatch = s.match(/(\d+(?:[.,]\d+)?)/);
  if (numMatch) {
    const num = parseFloat(numMatch[1].replace(',', '.'));
    if (!isNaN(num) && num >= 0) {
      // Heuristique : si < 30, c'est un pourcentage à multiplier par 10. Sinon déjà ×10.
      const tenth = num < 30 ? Math.round(num * 10) : Math.round(num);
      if (tenth === 0) return 'exempt';
      return `${country}_${tenth}`;
    }
  }
  throw new Error(`Code TVA invalide "${s}" — attendu format Pennylane "FR_200", "DE_190", "exempt", etc.`);
}

export async function resolveCustomerId(customer?: Record<string, unknown>, customerId?: string): Promise<string> {
  if (customerId) return customerId;
  if (!customer) throw new Error('Impossible de créer ou trouver le client');

  console.log('[pennylane] customer payload:', JSON.stringify(customer));

  const requestedType = (customer.type as string) || 'individual';

  // Chercher un client existant par email
  let resolved: string | null = null;
  let reusedExisting = false;
  if (customer.email) {
    const found = await findCustomerByEmail(customer.email as string);
    if (found) {
      console.log(`[pennylane] found existing customer ${found.id} type=${found.type}, requested type=${requestedType}`);
      if (found.type === requestedType) {
        // Même type → réutiliser le client existant
        resolved = found.id;
        reusedExisting = true;
      } else {
        // Type différent → créer un nouveau client du bon type
        console.log(`[pennylane] type mismatch: existing=${found.type}, requested=${requestedType} → creating new`);
        resolved = null;
      }
    }
  }
  if (!resolved) {
    const result = await createCustomer(customer);
    if (result.error) throw new Error(result.error);
    resolved = result.id || null;
  }
  if (!resolved) throw new Error('Impossible de créer ou trouver le client');

  // Client réutilisé : mettre à jour les adresses (facturation + livraison)
  // avec les valeurs du devis courant. Charles 02/07/2026 : on écrase même
  // si le customer existant avait déjà des adresses (l'adresse "vraie" est
  // celle du dernier chiffrage validé). Pour un CREATE frais, ces champs
  // sont déjà dans le POST initial → pas besoin d'un PUT en plus.
  if (reusedExisting) {
    const billing = toPennylaneAddress(customer.address as Record<string, string> | undefined);
    const delivery = toPennylaneAddress(customer.deliveryAddress as Record<string, string> | undefined);
    if (billing || delivery) {
      const updatePayload: Record<string, unknown> = {};
      if (billing) updatePayload.billing_address = billing;
      if (delivery) updatePayload.delivery_address = delivery;
      const endpoint = requestedType === 'company' ? 'company_customers' : 'individual_customers';
      try {
        const putRes = await fetch(`${PENNYLANE_API_URL}/${endpoint}/${resolved}`, {
          method: 'PUT',
          headers: pennylaneHeaders(),
          body: JSON.stringify(updatePayload),
        });
        console.log(`[pennylane] updated existing customer ${resolved} addresses → ${putRes.status} (billing=${!!billing}, delivery=${!!delivery})`);
      } catch (err) {
        // Non bloquant : le devis peut être créé même si la mise à jour
        // adresse échoue (fallback : freeText contient "Livraison à : X").
        console.warn(`[pennylane] address update failed for customer ${resolved} (non-blocking):`, err);
      }
    }
  }

  return resolved;
}

export async function createQuote(params: CreateQuoteParams): Promise<Record<string, unknown>> {
  const customerId = await resolveCustomerId(params.customer, params.customerId);

  if (!params.lines.length) throw new Error('Au moins une ligne de devis requise');

  const templateId = getTemplateId(params.inboxName || '');

  // Pays fallback pour normaliser les codes TVA numériques (ex: 20 → FR_200)
  const customerCountry = String(
    ((params.customer?.address as Record<string, unknown> | undefined)?.country as string | undefined) || 'FR'
  ).toUpperCase().slice(0, 2);

  const invoiceLines = params.lines.map((line, idx) => {
    const isProduct = (line.type || 'free') === 'product';
    let vatRate: string;
    try {
      vatRate = normalizeVatRate(line.vatRate, customerCountry);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'erreur inconnue';
      throw new Error(`Ligne ${idx + 1} (${line.label || '?'}) : ${msg}`);
    }
    return {
      label: line.label || '',
      quantity: line.quantity || 1,
      raw_currency_unit_price: String(line.unitPrice || 0),
      vat_rate: vatRate,
      unit: line.unit || (isProduct ? 'm2' : 'piece'),
      ...(isProduct && line.unit === 'm2' && (line.quantity || 0) % 1 !== 0 ? { product_id: PRODUCT_ID_FILET } : {}),
      ...(line.description ? { description: line.description } : {}),
    };
  });

  const today = new Date().toISOString().slice(0, 10);
  const defaultDeadline = new Date(Date.now() + 180 * 86400000).toISOString().slice(0, 10);

  const payload: Record<string, unknown> = {
    date: today,
    deadline: params.deadline || defaultDeadline,
    customer_id: customerId,
    currency: 'EUR',
    invoice_lines: invoiceLines,
    quote_template_id: templateId,
  };
  if (params.discountPercent && params.discountPercent > 0) {
    payload.discount = { type: 'relative', value: String(params.discountPercent) };
  }
  if (params.freeText) payload.pdf_invoice_free_text = params.freeText;

  const t0 = Date.now();
  const res = await fetch(`${PENNYLANE_API_URL}/quotes`, {
    method: 'POST',
    headers: pennylaneHeaders(),
    body: JSON.stringify(payload),
  });
  console.log(`[pennylane] createQuote → ${res.status} (${Date.now() - t0}ms)`);

  if (res.status === 200 || res.status === 201) {
    const d = await res.json();
    console.log('[pennylane] create quote response:', JSON.stringify(d, null, 2));

    const quoteNumber = d.quote_number || d.label || '';
    const companyId = process.env.PENNYLANE_COMPANY_ID || '21855877';
    const pennylaneUrl = `https://app.pennylane.com/companies/${companyId}/clients/customer_estimates?estimate_id=${d.id}`;

    return {
      success: true,
      quoteId: d.id,
      quoteNumber,
      pdfUrl: d.public_file_url || d.file_url,
      pennylaneUrl,
      amount: d.currency_amount_before_tax,
      amountTTC: d.currency_amount,
    };
  }

  const errBody = await res.text();
  let errMsg: string;
  try {
    const parsed = JSON.parse(errBody);
    errMsg = parsed.message || errBody;
    // Pennylane renvoie un message générique trompeur sur invoice_lines quand un champ
    // de ligne est invalide (vat_rate, unit, etc.). On enrichit l'erreur avec un dump
    // des champs critiques pour faciliter le debug en prod.
    if (errMsg.includes("schema of the object invoice_lines")) {
      const summary = invoiceLines.map((l, i) => `[${i + 1}] vat_rate=${(l as Record<string, unknown>).vat_rate} unit=${(l as Record<string, unknown>).unit} qty=${(l as Record<string, unknown>).quantity}`).join(' | ');
      errMsg = `${errMsg} — lignes : ${summary}`;
    }
  } catch { errMsg = errBody; }
  console.error('[pennylane] createQuote payload (failed):', JSON.stringify(payload));
  throw new Error(`Erreur Pennylane (${res.status}): ${errMsg}`);
}

/**
 * Upload une image comme appendice (pièce jointe) d'un devis Pennylane.
 */
export async function uploadQuoteAppendix(
  quoteId: string,
  imageBase64: string,
  mediaType: string,
  filename: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const imageBuffer = Buffer.from(imageBase64, 'base64');
    const boundary = `----FormBoundary${Date.now()}`;

    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mediaType}\r\n\r\n`),
      imageBuffer,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const t0 = Date.now();
    const res = await fetch(`${PENNYLANE_API_URL}/quotes/${quoteId}/appendices`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.PENNYLANE_API_TOKEN}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });

    console.log(`[pennylane] uploadAppendix ${filename} → ${res.status} (${Date.now() - t0}ms)`);
    if (res.ok) return { success: true };
    const errText = await res.text();
    return { success: false, error: `Pennylane ${res.status}: ${errText}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Erreur inconnue';
    console.error(`[pennylane] uploadAppendix error:`, msg);
    return { success: false, error: msg };
  }
}
