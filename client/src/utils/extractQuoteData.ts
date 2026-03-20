/**
 * Extraction des données devis depuis la réponse Claude.
 * Parse le JSON devis au format Pennylane (format-json-devis.txt).
 */

export interface QuoteCustomer {
  type: 'individual' | 'company';
  firstName?: string;
  lastName?: string;
  name?: string; // raison sociale (company)
  email?: string;
  phone?: string;
  vatNumber?: string;
  address?: {
    address?: string;
    postalCode?: string;
    city?: string;
  };
}

export interface QuoteLine {
  type: string; // product, accessory, transport, transport_discount, free
  label: string;
  description?: string;
  quantity: number;
  unitPrice: string; // toujours un string (format Pennylane)
  unit?: string;
}

export interface ExtractedQuote {
  store?: string;
  customer?: QuoteCustomer;
  lines: QuoteLine[];
  subject?: string;
}

export interface MissingField {
  key: string;
  label: string;
}

/**
 * Détecte si la réponse Claude contient un devis (mots-clés ou JSON).
 */
export function hasQuoteContent(text: string): boolean {
  const lower = text.toLowerCase();
  // Mots-clés devis
  if (
    (lower.includes('devis') || lower.includes('chiffrage')) &&
    (lower.includes('total ht') || lower.includes('total ttc') || lower.includes('prix unitaire') || lower.includes('€/m'))
  ) {
    return true;
  }
  // JSON devis détecté
  return extractQuoteData(text) !== null;
}

/**
 * Parse la réponse Claude pour extraire un JSON devis structuré.
 * Cherche dans les blocs ```json``` puis dans le texte brut.
 */
export function extractQuoteData(text: string): ExtractedQuote | null {
  // Chercher dans les blocs ```json```
  const codeBlockRegex = /```json\s*([\s\S]*?)```/g;
  let match;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    const parsed = tryParseQuote(match[1]);
    if (parsed) return parsed;
  }

  // Chercher un objet JSON brut contenant "lines"
  const braceRegex = /\{[\s\S]*?"lines"\s*:\s*\[[\s\S]*?\]\s*\}/g;
  while ((match = braceRegex.exec(text)) !== null) {
    const parsed = tryParseQuote(match[0]);
    if (parsed) return parsed;
  }

  return null;
}

function tryParseQuote(raw: string): ExtractedQuote | null {
  try {
    const data = JSON.parse(raw.trim());
    if (!data || !Array.isArray(data.lines) || data.lines.length === 0) return null;

    const customer: QuoteCustomer | undefined = data.customer
      ? {
          type: data.customer.type || 'individual',
          firstName: data.customer.firstName,
          lastName: data.customer.lastName,
          name: data.customer.name,
          email: data.customer.email,
          phone: data.customer.phone,
          vatNumber: data.customer.vatNumber,
          address: data.customer.address
            ? {
                address: data.customer.address.address,
                postalCode: data.customer.address.postalCode,
                city: data.customer.address.city,
              }
            : undefined,
        }
      : undefined;

    const lines: QuoteLine[] = data.lines.map((line: Record<string, unknown>) => ({
      type: (line.type as string) || 'product',
      label: (line.label as string) || '',
      description: line.description as string | undefined,
      quantity: Number(line.quantity) || 1,
      unitPrice: String(line.unitPrice ?? '0'),
      unit: (line.unit as string) || 'piece',
    }));

    return {
      store: data.store,
      customer,
      lines,
      subject: data.subject,
    };
  } catch {
    return null;
  }
}

/**
 * Vérifie les champs manquants pour créer le devis PDF.
 */
export function getMissingFields(quote: ExtractedQuote): MissingField[] {
  const missing: MissingField[] = [];

  if (!quote.customer) {
    missing.push({ key: 'customer', label: 'Informations client complètes' });
    return missing;
  }

  const c = quote.customer;

  if (c.type === 'company') {
    if (!c.name) missing.push({ key: 'name', label: 'Raison sociale' });
  } else {
    if (!c.firstName) missing.push({ key: 'firstName', label: 'Prénom' });
    if (!c.lastName) missing.push({ key: 'lastName', label: 'Nom' });
  }

  if (!c.email) missing.push({ key: 'email', label: 'Email' });

  if (!c.address?.address) missing.push({ key: 'address', label: 'Adresse (rue)' });
  if (!c.address?.postalCode) missing.push({ key: 'postalCode', label: 'Code postal' });
  if (!c.address?.city) missing.push({ key: 'city', label: 'Ville' });

  if (c.type === 'company' && !c.vatNumber) {
    missing.push({ key: 'vatNumber', label: 'N° TVA intracommunautaire' });
  }

  return missing;
}

/**
 * Calcule les totaux HT et TTC depuis les lignes du devis.
 */
export function computeTotals(lines: QuoteLine[]): { totalHT: number; totalTTC: number } {
  let totalHT = 0;
  for (const line of lines) {
    totalHT += line.quantity * parseFloat(line.unitPrice || '0');
  }
  const totalTTC = totalHT * 1.2; // TVA 20% par défaut
  return {
    totalHT: Math.round(totalHT * 100) / 100,
    totalTTC: Math.round(totalTTC * 100) / 100,
  };
}

/**
 * Formate le payload pour l'API /api/plugin/create-quote.
 */
export function formatQuotePayload(quote: ExtractedQuote, _storeCode: string, inboxName: string) {
  return {
    customer: quote.customer
      ? {
          type: quote.customer.type,
          firstName: quote.customer.firstName,
          lastName: quote.customer.lastName,
          name: quote.customer.name,
          email: quote.customer.email,
          phone: quote.customer.phone,
          vatNumber: quote.customer.vatNumber,
          address: quote.customer.address
            ? {
                street: quote.customer.address.address,
                zipCode: quote.customer.address.postalCode,
                city: quote.customer.address.city,
                country: 'FR',
              }
            : undefined,
        }
      : undefined,
    lines: quote.lines.map((l) => ({
      type: l.type === 'accessory' ? 'product' : l.type,
      label: l.label,
      description: l.description,
      quantity: l.quantity,
      unitPrice: parseFloat(l.unitPrice),
      vatRate: 'FR_200',
    })),
    subject: quote.subject,
    inboxName,
  };
}
