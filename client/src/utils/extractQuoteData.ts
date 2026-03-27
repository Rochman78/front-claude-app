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
    country?: string;
  };
}

/** Mapping store_code → pays par défaut du marché */
const STORE_DEFAULT_COUNTRY: Record<string, string> = {
  LFC: 'FR', LVO: 'FR', COCO: 'FR', MON: 'FR', UNI: 'FR',
  TAR: 'DE', HET: 'NL', RED: 'ES', RETE: 'IT',
};

/** Convertit un taux TVA (%) + pays en code Pennylane (ex: 'ES_210') */
function toPennylaneVatCode(rate: number, country: string): string {
  if (rate === 0) return 'tax_free_0';
  const rateInt = Math.round(rate * 10);
  return `${country}_${rateInt}`;
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
  extractedVatPercent?: number | null;
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

/**
 * Parse le texte naturel de Claude pour extraire les données du devis.
 * Cherche dans tout le texte (tous les messages concaténés) :
 * dimensions, matière, couleur, surface, prix unitaire, total HT/TTC.
 */
function extractFromText(text: string, context?: { customerEmail?: string; customerName?: string; storeCode?: string }): ExtractedQuote | null {
  console.log('[extractQuoteData] input text (500 chars):', text.substring(0, 500));
  console.log('[extractQuoteData] email regex test:', /(?:e-?mail|courriel)\s*[:：]\s*\n?\s*([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i.test(text));
  console.log('[extractQuoteData] all emails found in text:', text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g));
  console.log('[extractQuoteData] text length:', text.length);

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

  // Extraire le taux de TVA depuis le texte (AVANT le calcul des prix)
  const tvaRateMatch =
    text.match(/(?:TVA|tva|IVA|TVA applicable)[^)]*?\(?\s*(\d+(?:[.,]\d+)?)\s*%/i) ||
    text.match(/(?:taux\s*(?:de\s*)?(?:TVA|tva|IVA))[^)]*?[:=]?\s*(\d+(?:[.,]\d+)?)\s*%/i) ||
    text.match(/TVA\s*\(\s*(\d+(?:[.,]\d+)?)\s*%\s*\)/i) ||
    text.match(/(\d+(?:[.,]\d+)?)\s*%\s*(?:TVA|tva|IVA)/i);
  const extractedVatPercent = tvaRateMatch ? parseNumber(tvaRateMatch[1]) : null;
  const vatMultiplier = 1 + (extractedVatPercent !== null ? extractedVatPercent : 20) / 100;
  console.log('[extractQuoteData] extracted VAT rate:', extractedVatPercent !== null ? `${extractedVatPercent}%` : 'not found (default 20%)', 'multiplier:', vatMultiplier);

  console.log('[extractQuoteData] matches:', {
    prixUnitaire: prixUnitaireMatch?.[1],
    surface: surfaceMatch?.[1],
    totalHT: totalHTMatch?.[1],
    totalTTC: totalTTCMatch?.[1],
  });

  // On peut construire une ligne si on a :
  // - prix unitaire + surface, OU
  // - total HT, OU
  // - total TTC (on calcule le HT avec le vrai taux TVA)
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
  // RÈGLE : le prix dans le catalogue et les mails = prix TTC
  // On calcule le HT à partir du TTC en divisant par le vrai taux TVA
  let quantity: number;
  let unitPrice: string;

  if (totalTTCMatch) {
    // Priorité au TTC : c'est le prix de référence (catalogue / mails)
    const ttc = parseNumber(totalTTCMatch[1]);
    const ht = ttc / vatMultiplier;
    if (surfaceMatch) {
      quantity = parseNumber(surfaceMatch[1]);
      unitPrice = (ht / quantity).toFixed(2);
    } else {
      quantity = 1;
      unitPrice = ht.toFixed(2);
    }
    console.log('[extractQuoteData] TTC→HT conversion:', { ttc, vatMultiplier, ht: ht.toFixed(2) });
  } else if (surfaceMatch && prixUnitaireMatch) {
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

  // Helper : extraire un champ de formulaire Shopify (label sur même ligne OU ligne suivante)
  // Supporte : "Label: valeur" et "Label:\nvaleur"
  const getField = (label: RegExp): string => {
    const m = text.match(new RegExp(label.source + '\\s*[:：]\\s*\\n?\\s*([^\\n]+)', 'i'));
    return m ? m[1].trim() : '';
  };

  // Email client : vient du SDK (replyTo.handle), déjà résolu dans PluginMain
  const finalEmail = context?.customerEmail || '';
  console.log('[extractQuoteData] final email (from SDK replyTo):', finalEmail);

  // Extraire le nom depuis le corps du mail (prioritaire sur le SDK)
  // Supporte : Name, Nom, Nombre, Name, Naam, Nome + variantes "complet"
  const nameFromBody = getField(/(?:name|nom(?:\s*complet)?|nombre(?:\s*completo)?|naam|nome)/);
  const nameFromSDK = context?.customerName || '';
  // Ignorer les noms Shopify
  const isJunkName = (n: string) => !n || /shopify|filet.*camouflage|noreply|camuflaje|camouflage/i.test(n);
  const finalName = !isJunkName(nameFromBody) ? nameFromBody : !isJunkName(nameFromSDK) ? nameFromSDK : '';

  let customer: QuoteCustomer | undefined;

  // Détecter la raison sociale (FR/ES/DE/NL/IT)
  const raisonSocialeRaw = getField(/(?:raison\s*sociale|entreprise|société|empresa|razón\s*social|firma|unternehmen|bedrijf|azienda|ditta)(?:\s*\([^)]*\))?/);
  const companyName = raisonSocialeRaw;
  const isCompany = companyName.length > 0;

  // Chercher "Nom et prénom" / "Nombre" / "Name" (même ligne ou ligne suivante)
  const nomPrenomRaw = getField(/(?:nom\s*(?:et\s*)?prénom|prénom\s*(?:et\s*)?nom|nombre(?:\s*(?:y\s*)?apellidos?)?|nombre\s*completo|vor-?\s*und\s*nachname|naam|nome(?:\s*e\s*cognome)?)/);
  const nomPrenomParts = nomPrenomRaw.split(/\s+/).filter(Boolean);
  const nomPrenomMatch = nomPrenomParts.length >= 2 ? nomPrenomParts : null;

  if (nomPrenomMatch) {
    if (isCompany) {
      customer = {
        type: 'company',
        name: companyName,
        firstName: nomPrenomMatch[nomPrenomMatch.length - 1],
        lastName: nomPrenomMatch.slice(0, -1).join(' '),
        email: finalEmail,
      };
    } else {
      customer = {
        type: 'individual',
        firstName: nomPrenomMatch[0],
        lastName: nomPrenomMatch.slice(1).join(' '),
        email: finalEmail,
      };
    }
  } else if (isCompany) {
    customer = {
      type: 'company',
      name: companyName,
      email: finalEmail,
    };
  } else if (finalEmail || finalName) {
    const nameParts = finalName.split(/\s+/);
    customer = {
      type: 'individual',
      firstName: nameParts[0] || '',
      lastName: nameParts.slice(1).join(' ') || '',
      email: finalEmail,
    };
  }

  console.log('[extractQuoteData] customer:', { isCompany, companyName, nomPrenom: nomPrenomMatch?.join(' '), type: customer?.type });
  console.log('[extractQuoteData] customer payload:', JSON.stringify(customer));

  // Extraire l'adresse depuis le texte (multi-langues)
  // 1. Code postal + ville : "13500 Martigues", "CP 07141, Marratxí", "28001 Madrid"
  // Supporte formats FR/ES/DE/IT/NL (4-5 chiffres + ville)
  const cpVilleMatch = (() => {
    for (const line of text.split('\n')) {
      // Pattern "CP 07141, Marratxí" ou "C.P. 07141 Marratxí"
      const cpES = line.match(/(?:CP|C\.?P\.?)\s*(\d{4,5})[,\s]+([A-ZÀ-Ü][a-zà-ÿ]+(?:[\s-][A-Za-zÀ-ÿ]+)*)/i);
      if (cpES) return cpES;
      // Pattern générique "12345 Ville" (FR/DE/IT/ES)
      const m = line.match(/\b(\d{4,5})\s+([A-ZÀ-Ü][a-zà-ÿ]+(?:[\s-][A-Za-zÀ-ÿ]+)*)/);
      if (m) return m;
      // Pattern NL "1234 AB Ville"
      const nl = line.match(/\b(\d{4}\s*[A-Z]{2})\s+([A-ZÀ-Ü][a-zà-ÿ]+(?:[\s-][A-Za-zÀ-ÿ]+)*)/);
      if (nl) return nl;
    }
    return null;
  })();

  // 2. Rue : FR/ES/DE/NL/IT/EN types de voie
  const rueMatch = text.match(
    /(\d+[\s,]+(?:rue|avenue|boulevard|impasse|chemin|allée|place|cours|passage|voie|route|calle|avenida|paseo|plaza|camino|carrer|carretera|straße|strasse|weg|platz|gasse|straat|laan|plein|via|viale|piazza|corso|street|road|lane|drive|close|crescent|terrace|way|court)\s+[^\n]{2,50})/i
  ) || text.match(
    // Pattern ES/IT inversé : "Calle Tamarell, 5"
    /((?:calle|avenida|paseo|plaza|camino|carrer|carretera|via|viale|piazza|corso|straße|strasse)\s+[^\n,]{2,40}[,\s]+\d+[^\n]*)/i
  ) || text.match(
    // Pattern EN : "5 Baker Street" ou "123 Main Road"
    /(\d+\s+[A-Za-zÀ-ÿ]+\s+(?:street|road|lane|drive|avenue|close|crescent|terrace|way|court|place)[^\n]*)/i
  );

  // 3. Fallback : "adresse/dirección/indirizzo/adres/Adresse/address :" suivi du contenu
  const adresseLabelMatch = text.match(/(?:adresse(?:\s*(?:de\s*facturation|postale|complète))?|dirección|indirizzo|adres|anschrift|address)\s*[:=]\s*\n?\s*([^\n]+)/i);

  // 4. Téléphone (multi-langues + EN)
  const phoneMatch = text.match(/(?:tél(?:éphone)?|portable|mobile|tel(?:éfono)?|phone|telefon[oa]?|telefoon)\s*[:=]?\s*\n?\s*([\d\s.+-]{10,})/i)
    || text.match(/((?:0|\+\d{1,3})[67][\s.]?[\d\s.]{8,})/);

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
    extractedVatPercent: extractedVatPercent,
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

  // TVA intra obligatoire UNIQUEMENT si le client a fourni un numéro (2 lettres + chiffres)
  // Pas obligatoire pour les entreprises/associations qui n'en ont pas
  if (c.type === 'company' && c.vatNumber && !/^[A-Z]{2}\d/.test(c.vatNumber)) {
    missing.push({ key: 'vatNumber', label: 'N° TVA intracommunautaire (format invalide)' });
  }

  return missing;
}

// --- Calculs ---

export function computeTotals(lines: QuoteLine[], vatPercent?: number | null): { totalHT: number; totalTTC: number } {
  let totalHT = 0;
  for (const line of lines) {
    totalHT += line.quantity * parseFloat(line.unitPrice || '0');
  }
  const rate = vatPercent !== null && vatPercent !== undefined ? vatPercent : 20;
  const totalTTC = totalHT * (1 + rate / 100);
  return {
    totalHT: Math.round(totalHT * 100) / 100,
    totalTTC: Math.round(totalTTC * 100) / 100,
  };
}

// --- Formatage payload ---

export function formatQuotePayload(quote: ExtractedQuote, storeCode: string, inboxName: string) {
  // Dériver le pays depuis le n° TVA intra du client, l'adresse, ou le marché du store
  const vatCountry = quote.customer?.vatNumber?.match(/^([A-Z]{2})/)?.[1];
  const addressCountry = quote.customer?.address?.country;
  const defaultCountry = STORE_DEFAULT_COUNTRY[storeCode] || 'FR';
  const customerCountry = vatCountry || addressCountry || defaultCountry;

  // Déterminer le code TVA Pennylane depuis le taux extrait du brouillon
  const extractedRate = quote.extractedVatPercent;
  const vatCode = extractedRate !== null && extractedRate !== undefined
    ? toPennylaneVatCode(extractedRate, extractedRate === 0 ? 'FR' : customerCountry)
    : `${defaultCountry}_${defaultCountry === 'FR' ? '200' : defaultCountry === 'ES' ? '210' : defaultCountry === 'DE' ? '190' : defaultCountry === 'IT' ? '220' : defaultCountry === 'NL' ? '210' : '200'}`;

  console.log('[formatQuotePayload] country:', customerCountry, 'vatCode:', vatCode, 'storeCode:', storeCode);

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
                country: customerCountry,
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
      vatRate: vatCode,
    })),
    subject: quote.subject,
    inboxName,
  };
}
