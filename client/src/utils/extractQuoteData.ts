/**
 * Extraction des données devis depuis la réponse Claude.
 * Parse le texte naturel ou JSON pour construire le payload Pennylane.
 */

export interface QuoteCustomer {
  type: 'individual' | 'company';
  firstName?: string;
  lastName?: string;
  name?: string;
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
  type: string;
  label: string;
  description?: string;
  quantity: number;
  unitPrice: string;
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

// --- Détection ---

export function hasQuoteContent(text: string): boolean {
  const lower = text.toLowerCase();

  const hasContext = lower.includes('devis') || lower.includes('chiffrage') || lower.includes('voici le chiffrage');

  const hasPrice =
    lower.includes('total ht') || lower.includes('total ttc') ||
    lower.includes('prix unitaire') || lower.includes('€/m') ||
    lower.includes('m²') || lower.includes('€ ht') ||
    lower.includes('hors tva') || lower.includes('hors taxe') ||
    /\d+[.,]\d+\s*€/.test(lower) ||
    lower.includes('ttc');

  if (hasContext && hasPrice) return true;

  return extractQuoteData(text) !== null;
}

// --- Extraction ---

/**
 * Extrait les données devis depuis la réponse Claude.
 * Essaie d'abord le JSON structuré, puis parse le texte naturel.
 */
export function extractQuoteData(text: string, context?: { customerEmail?: string; customerName?: string; storeCode?: string }): ExtractedQuote | null {
  // 1. Essayer le JSON structuré (blocs ```json```)
  const jsonResult = extractFromJson(text);
  if (jsonResult) return jsonResult;

  // 2. Parser le texte naturel de Claude
  return extractFromText(text, context);
}

function extractFromJson(text: string): ExtractedQuote | null {
  const codeBlockRegex = /```json\s*([\s\S]*?)```/g;
  let match;
  while ((match = codeBlockRegex.exec(text)) !== null) {
    const parsed = tryParseJsonQuote(match[1]);
    if (parsed) return parsed;
  }
  const braceRegex = /\{[\s\S]*?"lines"\s*:\s*\[[\s\S]*?\]\s*\}/g;
  while ((match = braceRegex.exec(text)) !== null) {
    const parsed = tryParseJsonQuote(match[0]);
    if (parsed) return parsed;
  }
  return null;
}

function tryParseJsonQuote(raw: string): ExtractedQuote | null {
  try {
    const data = JSON.parse(raw.trim());
    if (!data || !Array.isArray(data.lines) || data.lines.length === 0) return null;
    return {
      store: data.store,
      customer: data.customer ? {
        type: data.customer.type || 'individual',
        firstName: data.customer.firstName,
        lastName: data.customer.lastName,
        name: data.customer.name,
        email: data.customer.email,
        phone: data.customer.phone,
        vatNumber: data.customer.vatNumber,
        address: data.customer.address ? {
          address: data.customer.address.address,
          postalCode: data.customer.address.postalCode,
          city: data.customer.address.city,
        } : undefined,
      } : undefined,
      lines: data.lines.map((line: Record<string, unknown>) => ({
        type: (line.type as string) || 'product',
        label: (line.label as string) || '',
        description: line.description as string | undefined,
        quantity: Number(line.quantity) || 1,
        unitPrice: String(line.unitPrice ?? '0'),
        unit: (line.unit as string) || 'piece',
      })),
      subject: data.subject,
    };
  } catch {
    return null;
  }
}

/**
 * Parse le texte naturel de Claude pour extraire les données du devis.
 * Cherche : dimensions, matière, couleur, surface, prix unitaire, total HT/TTC.
 */
function extractFromText(text: string, context?: { customerEmail?: string; customerName?: string; storeCode?: string }): ExtractedQuote | null {
  // Extraire le prix unitaire HT
  const prixUnitaireMatch = text.match(/(?:prix\s*(?:unitaire)?(?:\s*ht)?|tarif)\s*[:=]?\s*(\d+[.,]\d+)\s*€?\s*(?:ht)?(?:\s*\/\s*m[²2])?/i)
    || text.match(/(\d+[.,]\d+)\s*€\s*(?:ht\s*)?(?:\/\s*m[²2]|par\s*m[²2])/i);

  // Extraire la surface
  const surfaceMatch = text.match(/(?:surface(?:\s*totale)?)\s*[:=]?\s*(\d+[.,]\d+)\s*m[²2]/i);

  // Extraire le total HT
  const totalHTMatch = text.match(/(?:total\s*ht|montant\s*ht)\s*[:=]?\s*(\d+[.,]\d+)\s*€/i);

  // Si on n'a ni prix unitaire + surface, ni total HT, on ne peut pas construire de ligne
  if (!totalHTMatch && !(prixUnitaireMatch && surfaceMatch)) return null;

  // Extraire les dimensions
  const dimMatch = text.match(/(\d+[.,]\d+)\s*x\s*(\d+[.,]\d+)\s*m/i);

  // Extraire matière et couleur
  const matiereMatch = text.match(/(?:matière|finition|type)\s*[:=]?\s*([A-Za-zÀ-ÿ\s]+?)(?:\n|$|,)/i);
  const couleurMatch = text.match(/(?:couleur)\s*[:=]?\s*([A-Za-zÀ-ÿ\s]+?)(?:\n|$|,)/i);

  // Construire le label du produit
  const couleur = couleurMatch ? couleurMatch[1].trim() : '';
  const matiere = matiereMatch ? matiereMatch[1].trim() : '';
  const dimensions = dimMatch ? `${dimMatch[1]} x ${dimMatch[2]} m` : '';

  const labelParts = [couleur, dimensions, matiere ? `Filet ${matiere.toLowerCase()}` : 'Filet sur mesure'].filter(Boolean);
  const label = labelParts.join(' - ') || 'Produit sur mesure';

  // Déterminer quantité et prix
  let quantity: number;
  let unitPrice: string;

  if (surfaceMatch && prixUnitaireMatch) {
    quantity = parseNumber(surfaceMatch[1]);
    unitPrice = parseNumber(prixUnitaireMatch[1]).toFixed(2);
  } else if (totalHTMatch && surfaceMatch) {
    quantity = parseNumber(surfaceMatch[1]);
    unitPrice = (parseNumber(totalHTMatch[1]) / quantity).toFixed(2);
  } else if (totalHTMatch) {
    quantity = 1;
    unitPrice = parseNumber(totalHTMatch[1]).toFixed(2);
  } else {
    return null;
  }

  const lines: QuoteLine[] = [{
    type: 'product',
    label: label.toUpperCase().substring(0, 3) === label.substring(0, 3) ? label : label,
    description: dimensions ? `Dimensions : ${dimensions}` : undefined,
    quantity,
    unitPrice,
    unit: 'm2',
  }];

  // Détecter livraison offerte
  const livraisonOfferte = /livraison\s*(?:offerte|gratuite|incluse)/i.test(text);
  if (livraisonOfferte) {
    lines.push({ type: 'transport', label: 'Transport sur mesure', quantity: 1, unitPrice: '19.99', unit: 'piece' });
    lines.push({ type: 'transport_discount', label: 'Remise transport sur mesure', quantity: 1, unitPrice: '-19.99', unit: 'piece' });
  }

  // Construire le sujet
  const subject = `Devis ${matiere ? matiere.toLowerCase() + ' ' : ''}${couleur ? couleur.toLowerCase() + ' ' : ''}${dimensions || 'sur mesure'}`.trim();

  // Construire le customer depuis le contexte
  let customer: QuoteCustomer | undefined;
  if (context?.customerEmail || context?.customerName) {
    const nameParts = (context.customerName || '').split(/\s+/);
    customer = {
      type: 'individual',
      firstName: nameParts[0] || '',
      lastName: nameParts.slice(1).join(' ') || '',
      email: context.customerEmail || '',
    };
  }

  // Essayer d'extraire l'adresse depuis le texte
  const adresseMatch = text.match(/(?:adresse|adresse\s*de\s*facturation)\s*[:=]?\s*(.+?)(?:\n|$)/i);
  const cpVilleMatch = text.match(/(\d{5})\s+([A-Za-zÀ-ÿ\s-]+?)(?:\n|$|,)/);
  if (customer && (adresseMatch || cpVilleMatch)) {
    customer.address = {
      address: adresseMatch ? adresseMatch[1].trim() : '',
      postalCode: cpVilleMatch ? cpVilleMatch[1] : '',
      city: cpVilleMatch ? cpVilleMatch[2].trim() : '',
    };
  }

  return {
    store: context?.storeCode,
    customer,
    lines,
    subject,
  };
}

function parseNumber(str: string): number {
  return parseFloat(str.replace(',', '.'));
}

// --- Validation ---

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

// --- Calculs ---

export function computeTotals(lines: QuoteLine[]): { totalHT: number; totalTTC: number } {
  let totalHT = 0;
  for (const line of lines) {
    totalHT += line.quantity * parseFloat(line.unitPrice || '0');
  }
  const totalTTC = totalHT * 1.2;
  return {
    totalHT: Math.round(totalHT * 100) / 100,
    totalTTC: Math.round(totalTTC * 100) / 100,
  };
}

// --- Formatage payload ---

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
