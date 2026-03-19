import { NextRequest, NextResponse } from 'next/server';

const PENNYLANE_API_URL = 'https://app.pennylane.com/api/external/v2';

const STORE_CONFIG: Record<string, [string, number]> = {
  'le filet':      ['LFC',  253634],
  'le voile':      ['LVO',  877143],
  'tarnnetz':      ['TAR',  257174],
  'ma toile coco': ['COCO', 257180],
  'het':           ['HET',  257162],
  'red':           ['RED',  257168],
  'rete':          ['RETE', 861190],
  'mon ombrage':   ['MON',  883869],
  'univers':       ['UNI',  883875],
};

const PRODUCT_ID_FILET   = 14369303;
const PRODUCT_ID_GENERIC = 16822267;

function getStoreConfig(inboxName: string): [string, number] {
  const lower = (inboxName || '').toLowerCase();
  for (const [key, val] of Object.entries(STORE_CONFIG)) {
    if (lower.includes(key)) return val;
  }
  return ['LFC', 253634];
}

function pennylaneHeaders() {
  return {
    Authorization: `Bearer ${process.env.PENNYLANE_API_TOKEN}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

async function findCustomerByEmail(email: string): Promise<string | null> {
  try {
    const res = await fetch(
      `${PENNYLANE_API_URL}/customers?filter=${encodeURIComponent(JSON.stringify([{ field: 'emails', operator: 'in', value: [email] }]))}`,
      { headers: pennylaneHeaders() }
    );
    if (res.ok) {
      const data = await res.json();
      const items = data.items || [];
      if (items.length > 0) return items[0].id;
    }
  } catch { /* ignore */ }
  return null;
}

async function createCustomer(customer: Record<string, unknown>): Promise<{ id?: string; error?: string }> {
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

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: pennylaneHeaders(),
    body: JSON.stringify(payload),
  });

  if (res.status === 200 || res.status === 201) return res.json();
  const text = await res.text();
  return { error: `Erreur création client: ${text}` };
}

export async function POST(req: NextRequest) {
  try {
    if (!process.env.PENNYLANE_API_TOKEN) {
      return NextResponse.json({ error: 'PENNYLANE_API_TOKEN non configuré' }, { status: 500 });
    }

    const data = await req.json();
    const { customer, customerId, lines = [], subject, deadline, freeText, inboxName } = data;

    // Resolve customer ID
    let resolvedCustomerId = customerId;
    if (!resolvedCustomerId && customer) {
      if (customer.email) {
        resolvedCustomerId = await findCustomerByEmail(customer.email);
      }
      if (!resolvedCustomerId) {
        const result = await createCustomer(customer);
        if (result.error) return NextResponse.json({ error: result.error }, { status: 400 });
        resolvedCustomerId = result.id;
      }
    }

    if (!resolvedCustomerId) {
      return NextResponse.json({ error: 'Impossible de créer ou trouver le client' }, { status: 400 });
    }
    if (!lines.length) {
      return NextResponse.json({ error: 'Au moins une ligne de devis requise' }, { status: 400 });
    }

    const [, templateId] = getStoreConfig(inboxName || '');

    const invoiceLines = lines.map((line: Record<string, unknown>) => {
      const lineType = (line.type as string) || 'free';
      const isProduct = lineType === 'product';
      return {
        label: line.label || '',
        quantity: line.quantity || 1,
        raw_currency_unit_price: String(line.unitPrice || 0),
        vat_rate: line.vatRate || 'FR_200',
        unit: isProduct ? 'm2' : 'piece',
        product_id: isProduct ? PRODUCT_ID_FILET : PRODUCT_ID_GENERIC,
        ...(line.description ? { description: line.description } : {}),
      };
    });

    const today = new Date().toISOString().slice(0, 10);
    const defaultDeadline = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

    const payload: Record<string, unknown> = {
      date: today,
      deadline: deadline || defaultDeadline,
      customer_id: resolvedCustomerId,
      currency: 'EUR',
      invoice_lines: invoiceLines,
      quote_template_id: templateId,
    };
    if (subject) payload.pdf_invoice_subject = subject;
    if (freeText) payload.pdf_invoice_free_text = freeText;

    const res = await fetch(`${PENNYLANE_API_URL}/quotes`, {
      method: 'POST',
      headers: pennylaneHeaders(),
      body: JSON.stringify(payload),
    });

    if (res.status === 200 || res.status === 201) {
      const d = await res.json();
      return NextResponse.json({
        success: true,
        quoteId: d.id,
        quoteNumber: d.quote_number || d.label,
        pdfUrl: d.public_file_url,
        amount: d.currency_amount_before_tax,
        amountTTC: d.currency_amount,
      });
    }

    let errMsg: string;
    try { errMsg = (await res.json()).message || await res.text(); }
    catch { errMsg = await res.text(); }
    return NextResponse.json({ error: `Erreur Pennylane (${res.status}): ${errMsg}` }, { status: 400 });

  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Erreur inconnue';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
