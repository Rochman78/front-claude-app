/**
 * Service Pennylane — centralise la logique de création de devis.
 */

import { getStoreByInboxName } from '@/lib/stores';

const PENNYLANE_API_URL = 'https://app.pennylane.com/api/external/v2';

const PRODUCT_ID_FILET   = 14369303;
const PRODUCT_ID_GENERIC = 16822267;

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

export async function createCustomer(customer: Record<string, unknown>): Promise<{ id?: string; error?: string }> {
  const type = (customer.type as string) || 'individual';
  const payload: Record<string, unknown> = {};

  if (customer.email) payload.emails = [customer.email];
  if (customer.phone) payload.phone = customer.phone;

  const address = customer.address as Record<string, string> | undefined;
  if (address && Object.values(address).some(Boolean)) {
    payload.billing_address = {
      address: address.street || '',
      postal_code: address.zipCode || '',
      city: address.city || '',
      country_alpha2: address.country || 'FR',
    };
  }

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
  inboxName?: string;
}

export async function resolveCustomerId(customer?: Record<string, unknown>, customerId?: string): Promise<string> {
  if (customerId) return customerId;
  if (!customer) throw new Error('Impossible de créer ou trouver le client');

  console.log('[pennylane] customer payload:', JSON.stringify(customer));

  const requestedType = (customer.type as string) || 'individual';

  // Chercher un client existant par email
  let resolved: string | null = null;
  if (customer.email) {
    const found = await findCustomerByEmail(customer.email as string);
    if (found) {
      console.log(`[pennylane] found existing customer ${found.id} type=${found.type}, requested type=${requestedType}`);
      if (found.type === requestedType) {
        // Même type → réutiliser le client existant
        resolved = found.id;
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
  return resolved;
}

export async function createQuote(params: CreateQuoteParams): Promise<Record<string, unknown>> {
  const customerId = await resolveCustomerId(params.customer, params.customerId);

  if (!params.lines.length) throw new Error('Au moins une ligne de devis requise');

  const templateId = getTemplateId(params.inboxName || '');

  const invoiceLines = params.lines.map((line) => {
    const isProduct = (line.type || 'free') === 'product';
    // Normalise les codes TVA invalides
    let vatRate = line.vatRate || 'FR_200';
    if (vatRate === 'tax_free_0' || vatRate === 'tax_free') vatRate = 'exempt';
    return {
      label: line.label || '',
      quantity: line.quantity || 1,
      raw_currency_unit_price: String(line.unitPrice || 0),
      vat_rate: vatRate,
      unit: line.unit || (isProduct ? 'm2' : 'piece'),
      product_id: isProduct ? PRODUCT_ID_FILET : PRODUCT_ID_GENERIC,
      ...(line.description ? { description: line.description } : {}),
    };
  });

  const today = new Date().toISOString().slice(0, 10);
  const defaultDeadline = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

  const payload: Record<string, unknown> = {
    date: today,
    deadline: params.deadline || defaultDeadline,
    customer_id: customerId,
    currency: 'EUR',
    invoice_lines: invoiceLines,
    quote_template_id: templateId,
  };
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
  try { errMsg = JSON.parse(errBody).message || errBody; }
  catch { errMsg = errBody; }
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
