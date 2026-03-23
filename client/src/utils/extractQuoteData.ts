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
 * Parse UNIQUEMENT le texte naturel — jamais de JSON structuré
 * (qui pourrait contenir des données d'une ancienne conversation).
 */
export function extractQuoteData(text: string, context?: { customerEmail?: string; customerName?: string; storeCode?: string }): ExtractedQuote | null {
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
 * Cherche dans tout le texte (tous les messages concaténés) :
 * dimensions, matière, couleur, surface, prix unitaire, total HT/TTC.
 */
function extractFromText(text: string, context?: { customerEmail?: string; customerName?: string; storeCode?: string }): ExtractedQuote | null {
  console.log('[extractQuoteData] input text (500 chars):', text.substring(0, 500));

  // Extraire le prix unitaire HT — patterns variés
  const prixUnitaireMatch =
    text.match(/prix\s*unitaire\s*(?:hors\s*(?:tva|taxe)|ht)\s*[:=]?\s*(\d+[.,]\d+)\s*€?\s*(?:\/\s*m[²2])?/i) ||
    text.match(/(?:prix\s*(?:unitaire)?(?:\s*ht)?|tarif)\s*[:=]?\s*(\d+[.,]\d+)\s*€?\s*(?:ht)?\s*(?:\/\s*m[²2])?/i) ||
    text.match(/(\d+[.,]\d+)\s*€\s*(?:ht\s*)?(?:\/\s*m[²2]|par\s*m[²2])/i) ||
    text.match(/(\d+[.,]\d+)\s*€\s*\/\s*m[²2]/i);

  // Extraire la surface — patterns variés (supporte entiers et décimaux)
  const surfaceMatch =
    text.match(/surface\s*(?:totale|unitaire)?\s*[:=]?\s*(\d+[.,]?\d*)\s*m[²2]/i) ||
    text.match(/(\d+[.,]?\d*)\s*m[²2]\s*(?:au total|total)?/i);

  // Extraire le total HT — patterns variés
  const totalHTMatch =
    text.match(/(?:total|montant)\s*(?:hors\s*(?:tva|taxe)|ht)\s*[:=]?\s*(\d+[.,]\d+)\s*€/i) ||
    text.match(/(?:total|montant)\s*ht\s*[:=]?\s*(\d+[.,]\d+)\s*€/i);

  // Extraire le montant TTC — patterns variés
  const totalTTCMatch =
    text.match(/(?:total|montant)\s*ttc\s*[:=]?\s*(\d+[.,]\d+)\s*€/i) ||
    text.match(/ttc\s*[:=]?\s*(\d+[.,]\d+)\s*€/i) ||
    text.match(/montant\s*ttc\s*[:=—–-]\s*(\d+[.,]\d+)\s*€/i);

  console.log('[extractQuoteData] matches:', {
    prixUnitaire: prixUnitaireMatch?.[1],
    surface: surfaceMatch?.[1],
    totalHT: totalHTMatch?.[1],
    totalTTC: totalTTCMatch?.[1],
  });

  // On peut construire une ligne si on a :
  // - prix unitaire + surface, OU
  // - total HT, OU
  // - total TTC (on calcule le HT en divisant par 1.2)
  if (!totalHTMatch && !totalTTCMatch && !(prixUnitaireMatch && surfaceMatch)) return null;

  // Extraire les dimensions — supporte × et x, entiers et décimaux
  const dimMatch = text.match(/(\d+[.,]?\d*)\s*[x×]\s*(\d+[.,]?\d*)\s*m/i);

  // Extraire matière/finition et couleur
  const matiereMatch = text.match(/(?:matière|finition|type)\s*[:=]?\s*([A-Za-zÀ-ÿ\s]+?)(?:\n|$|,)/i);
  const couleurMatch = text.match(/(?:couleur)\s*[:=]?\s*([A-Za-zÀ-ÿ\s]+?)(?:\n|$|,)/i);

  // Extraire la quantité (nombre de filets commandés)
  const qtyMatch = text.match(/(?:quantité|qté|qty)\s*[:=]?\s*(\d+)/i);
  const orderQty = qtyMatch ? parseInt(qtyMatch[1], 10) : 1;

  // Construire le label : "[Couleur] - [LxH m] - Filet de camouflage renforcé [finition]"
  const couleur = couleurMatch ? couleurMatch[1].trim() : '';
  const matiere = matiereMatch ? matiereMatch[1].trim() : '';
  const dimLabel = dimMatch ? `${dimMatch[1].replace(',', '.')}x${dimMatch[2].replace(',', '.')} m` : '';
  const finition = matiere ? `Filet de camouflage renforcé ${matiere.toLowerCase()}` : 'Filet de camouflage renforcé sur mesure';

  const labelParts = [couleur, dimLabel, finition].filter(Boolean);
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
  } else if (totalTTCMatch) {
    // Calculer le HT depuis le TTC (TVA 20%)
    const ttc = parseNumber(totalTTCMatch[1]);
    const ht = ttc / 1.2;
    if (surfaceMatch) {
      quantity = parseNumber(surfaceMatch[1]);
      unitPrice = (ht / quantity).toFixed(2);
    } else {
      quantity = 1;
      unitPrice = ht.toFixed(2);
    }
  } else {
    return null;
  }

  console.log('[extractQuoteData] line values:', { surface: quantity, unitPricePerM2: unitPrice, totalHT: (quantity * parseFloat(unitPrice)).toFixed(2) });

  // Description : "Quantité : X | Total m² : Y | Délai de production + livraison : environ 14 jours"
  const descParts = [];
  if (orderQty > 0) descParts.push(`Quantité : ${orderQty}`);
  if (quantity > 0) descParts.push(`Total m² : ${quantity}`);
  descParts.push('Délai de production + livraison : environ 14 jours');
  const description = descParts.join(' | ');

  const lines: QuoteLine[] = [{
    type: 'product',
    label,
    description,
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
  const subject = `Devis ${matiere ? matiere.toLowerCase() + ' ' : ''}${couleur ? couleur.toLowerCase() + ' ' : ''}${dimLabel || 'sur mesure'}`.trim();

  // Construire le customer depuis le contexte + texte
  let customer: QuoteCustomer | undefined;

  // Détecter la raison sociale (entreprise, IUT, collectivité, etc.)
  const raisonSocialeMatch = text.match(/(?:raison\s*sociale|entreprise|société)\s*(?:\([^)]*\))?\s*[:=]\s*([^\n]+)/i);
  const companyName = raisonSocialeMatch ? raisonSocialeMatch[1].trim() : '';
  const isCompany = companyName.length > 0;

  // Chercher "Nom et prénom : Jérôme Muratore" ou "Nom et prénom : Marey Sylvie"
  const nomPrenomMatch = text.match(/(?:nom\s*(?:et\s*)?prénom|prénom\s*(?:et\s*)?nom)\s*[:=]?\s*([A-Za-zÀ-ÿ-]+)\s+([A-Za-zÀ-ÿ-]+)/i);

  if (nomPrenomMatch) {
    if (isCompany) {
      // Pro : raison sociale + contact
      customer = {
        type: 'company',
        name: companyName,
        firstName: nomPrenomMatch[2],
        lastName: nomPrenomMatch[1],
        email: context?.customerEmail || '',
      };
    } else {
      customer = {
        type: 'individual',
        firstName: nomPrenomMatch[1],
        lastName: nomPrenomMatch[2],
        email: context?.customerEmail || '',
      };
    }
  } else if (isCompany) {
    // Pro sans contact nommé
    customer = {
      type: 'company',
      name: companyName,
      email: context?.customerEmail || '',
    };
  } else if (context?.customerEmail || context?.customerName) {
    const nameParts = (context.customerName || '').split(/\s+/);
    customer = {
      type: 'individual',
      firstName: nameParts[0] || '',
      lastName: nameParts.slice(1).join(' ') || '',
      email: context.customerEmail || '',
    };
  }

  console.log('[extractQuoteData] customer:', { isCompany, companyName, nomPrenom: nomPrenomMatch?.[0], type: customer?.type });
  console.log('[extractQuoteData] customer payload:', JSON.stringify(customer));

  // Extraire l'adresse depuis le texte (format libre français)
  // 1. Code postal + ville : "13500 Martigues" (5 chiffres + mot(s) sur la même ligne)
  // Split par lignes pour extraire CP+ville proprement (éviter que \s matche \n)
  const cpVilleMatch = (() => {
    for (const line of text.split('\n')) {
      const m = line.match(/\b(\d{5})\s+([A-ZÀ-Ü][a-zà-ÿ]+(?:[\s-][A-Za-zÀ-ÿ]+)*)/);
      if (m) return m;
    }
    return null;
  })();

  // 2. Rue : ligne contenant un numéro + type de voie
  const rueMatch = text.match(/(\d+[\s,]+(?:rue|avenue|boulevard|impasse|chemin|allée|place|cours|passage|voie|route)\s+[^\n]{2,50})/i);

  // 3. Fallback : pattern "adresse :" suivi du contenu
  const adresseLabelMatch = text.match(/(?:adresse(?:\s*(?:de\s*facturation|postale|complète))?)\s*[:=]\s*([^\n]+)/i);

  // 4. Téléphone
  const phoneMatch = text.match(/(?:tél(?:éphone)?|portable|mobile|tel)\s*[:=]?\s*([\d\s.+-]{10,})/i)
    || text.match(/(0[67][\s.]?[\d\s.]{8,})/);

  console.log('[extractQuoteData] address matches:', {
    cpVille: cpVilleMatch ? cpVilleMatch[1] + ' ' + cpVilleMatch[2] : null,
    rue: rueMatch?.[1]?.trim() || null,
    adresseLabel: adresseLabelMatch?.[1]?.trim() || null,
    phone: phoneMatch?.[1] || null,
    nomPrenom: nomPrenomMatch ? nomPrenomMatch[1] + ' ' + nomPrenomMatch[2] : null,
  });

  if (customer) {
    const rue = rueMatch?.[1]?.trim() || adresseLabelMatch?.[1]?.trim() || '';
    if (rue || cpVilleMatch) {
      customer.address = {
        address: rue,
        postalCode: cpVilleMatch ? cpVilleMatch[1] : '',
        city: cpVilleMatch ? cpVilleMatch[2].trim() : '',
      };
    }
    if (phoneMatch && !customer.phone) {
      customer.phone = phoneMatch[1].replace(/[\s.]/g, '');
    }
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
