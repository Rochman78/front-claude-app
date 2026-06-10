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
  TAR: 'DE', HET: 'NL', RED: 'ES', REDE: 'PT', RETE: 'IT',
};

/** Mapping store_code → langue des labels devis */
const STORE_LABEL_LANG: Record<string, string> = {
  LFC: 'fr', LVO: 'fr', COCO: 'fr', MON: 'fr', UNI: 'fr',
  TAR: 'de', HET: 'nl', RED: 'es', REDE: 'pt', RETE: 'it',
};

/** Taux TVA normaux par pays (2026) — pour résoudre pays depuis le taux */
const VAT_RATES_BY_COUNTRY: Record<string, number> = {
  AT: 20, BE: 21, BG: 20, HR: 25, CY: 19, CZ: 21, DK: 25,
  EE: 24, FI: 25.5, FR: 20, DE: 19, GR: 24, HU: 27, IE: 23,
  IT: 22, LV: 21, LT: 21, LU: 17, MT: 18, NL: 21, PL: 23,
  PT: 23, RO: 19, SK: 20, SI: 22, ES: 21, SE: 25,
};

/** Détecte le pays depuis le texte de l'adresse (noms de pays, codes postaux) */
function detectCountryFromText(text: string): string | null {
  const lower = text.toLowerCase();
  const countryNames: Record<string, string[]> = {
    FR: ['france', 'français'],
    DE: ['germany', 'deutschland', 'allemagne', 'alemania', 'germania', 'duitsland'],
    AT: ['austria', 'österreich', 'autriche', 'oostenrijk'],
    BE: ['belgium', 'belgique', 'belgien', 'belgio', 'belgië'],
    NL: ['netherlands', 'pays-bas', 'niederlande', 'paesi bassi', 'nederland'],
    ES: ['spain', 'españa', 'espagne', 'spanien', 'spagna', 'spanje'],
    IT: ['italy', 'italia', 'italie', 'italien', 'italië'],
    PT: ['portugal'],
    CH: ['switzerland', 'suisse', 'schweiz', 'svizzera', 'zwitserland'],
    LU: ['luxembourg', 'luxemburg', 'lussemburgo'],
    IE: ['ireland', 'irlande', 'irland', 'irlanda', 'ierland'],
    PL: ['poland', 'pologne', 'polen', 'polonia'],
    CZ: ['czech', 'tchéquie', 'tschechien', 'cechia'],
    DK: ['denmark', 'danemark', 'dänemark', 'danimarca', 'denemarken'],
    SE: ['sweden', 'suède', 'schweden', 'svezia', 'zweden'],
    FI: ['finland', 'finlande', 'finnland', 'finlandia'],
    GR: ['greece', 'grèce', 'griechenland', 'grecia', 'griekenland'],
    HU: ['hungary', 'hongrie', 'ungarn', 'ungheria', 'hongarije'],
    RO: ['romania', 'roumanie', 'rumänien'],
    BG: ['bulgaria', 'bulgarie', 'bulgarien'],
    HR: ['croatia', 'croatie', 'kroatien', 'croazia', 'kroatië'],
    SK: ['slovakia', 'slovaquie', 'slowakei', 'slovacchia'],
    SI: ['slovenia', 'slovénie', 'slowenien'],
    EE: ['estonia', 'estonie', 'estland'],
    LV: ['latvia', 'lettonie', 'lettland'],
    LT: ['lithuania', 'lituanie', 'litauen'],
  };
  for (const [code, names] of Object.entries(countryNames)) {
    if (names.some((n) => lower.includes(n))) return code;
  }
  return null;
}

/** Convertit un taux TVA (%) + pays en code Pennylane (ex: 'AT_200') */
function toPennylaneVatCode(rate: number, country: string): string {
  if (rate === 0) return 'exempt';
  const rateInt = Math.round(rate * 10);
  // Pennylane exige le code pays alpha-2 en MAJUSCULES (sinon HTTP 400 trompeur)
  const cc = String(country || 'FR').toUpperCase().slice(0, 2);
  return `${cc}_${rateInt}`;
}

/** Trouve le pays à partir du taux TVA et du texte complet */
function resolveCountryFromVatRate(rate: number, fullText: string, defaultCountry: string): string {
  // 1. Chercher le pays dans le texte (noms de pays)
  const fromText = detectCountryFromText(fullText);
  if (fromText) return fromText;

  // 2. Si le taux est unique à un pays, l'utiliser
  const matchingCountries = Object.entries(VAT_RATES_BY_COUNTRY).filter(([, r]) => r === rate).map(([c]) => c);
  if (matchingCountries.length === 1) return matchingCountries[0];

  // 3. Si le taux matche le pays par défaut du store, l'utiliser
  if (VAT_RATES_BY_COUNTRY[defaultCountry] === rate) return defaultCountry;

  // 4. Fallback
  return defaultCountry;
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
  _fullText?: string;
}

export interface MissingField {
  key: string;
  label: string;
}

// --- Détection ---

export function hasQuoteContent(text: string): boolean {
  // Détection rapide d'un bloc JSON devis
  if (/```json[\s\S]*?"lines"\s*:/.test(text)) return true;

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
 * Tente d'abord de parser un bloc JSON structuré (```json ... ```),
 * puis fallback sur le parsing texte naturel.
 */
export function extractQuoteData(text: string, context?: { customerEmail?: string; customerName?: string; storeCode?: string; claudeText?: string }): ExtractedQuote | null {
  // 1. Essayer de parser un bloc JSON dans la réponse Claude
  const sourceText = context?.claudeText || text;
  const jsonQuote = extractFromJSON(sourceText, context);
  if (jsonQuote) return jsonQuote;

  // 2. Fallback sur le parsing texte naturel
  return extractFromText(text, context);
}

/**
 * Tente d'extraire un devis depuis un bloc JSON (```json ... ```) dans la réponse Claude.
 */
function extractFromJSON(text: string, context?: { customerEmail?: string; customerName?: string; storeCode?: string }): ExtractedQuote | null {
  // Chercher un bloc ```json ... ```
  const jsonBlockMatch = text.match(/```json\s*\n([\s\S]*?)\n\s*```/);
  if (!jsonBlockMatch) return null;

  try {
    const parsed = JSON.parse(jsonBlockMatch[1]);

    // Vérifier que ça ressemble à un devis (a des lignes produit)
    if (!parsed.lines || !Array.isArray(parsed.lines) || parsed.lines.length === 0) return null;

    const lines: QuoteLine[] = parsed.lines.map((l: Record<string, unknown>) => ({
      type: (l.type as string) || 'product',
      label: (l.label as string) || '',
      description: (l.description as string) || undefined,
      quantity: Number(l.quantity) || 1,
      unitPrice: String(l.unitPrice ?? '0'),
      unit: (l.unit as string) || undefined,
    }));

    const customerType = parsed.customer?.type === 'company' ? 'company' as const : 'individual' as const;
    const customer: QuoteCustomer | undefined = parsed.customer ? {
      type: customerType,
      firstName: (parsed.customer.firstName as string) || '',
      lastName: (parsed.customer.lastName as string) || '',
      name: (parsed.customer.companyName as string) || (parsed.customer.name as string) || '',
      email: (parsed.customer.email as string) || context?.customerEmail || '',
      phone: (parsed.customer.phone as string) || '',
      vatNumber: (parsed.customer.vatNumber as string) || '',
      address: parsed.customer.address ? {
        address: (parsed.customer.address.address as string) || '',
        postalCode: (parsed.customer.address.postalCode as string) || '',
        city: (parsed.customer.address.city as string) || '',
        country: (parsed.customer.address.country as string) || '',
      } : undefined,
    } : undefined;

    console.log('[extractQuoteData] JSON block parsed successfully:', lines.length, 'lines');

    return {
      store: (parsed.store as string) || context?.storeCode,
      customer,
      lines,
      subject: (parsed.subject as string) || undefined,
      extractedVatPercent: parsed.vatPercent !== undefined ? Number(parsed.vatPercent) : null,
      _fullText: text,
    };
  } catch (e) {
    console.warn('[extractQuoteData] JSON parse failed:', e);
    return null;
  }
}

/**
 * Parse le texte naturel de Claude pour extraire les données du devis.
 * Cherche dans tout le texte (tous les messages concaténés) :
 * dimensions, matière, couleur, surface, prix unitaire, total HT/TTC.
 */
function extractFromText(text: string, context?: { customerEmail?: string; customerName?: string; storeCode?: string; claudeText?: string }): ExtractedQuote | null {
  // Pour les prix/produits, utiliser claudeText (dernier brouillon) pour éviter les doublons
  // depuis le mailThread. Pour les infos client, utiliser text (fullText = mail + claude).
  const priceText = context?.claudeText || text;
  console.log('[extractQuoteData] text length:', text.length, 'priceText length:', priceText.length);

  // Extraire le prix unitaire HT — patterns variés (FR/NL/DE/ES/IT/EN)
  const prixUnitaireMatch =
    priceText.match(/prix\s*unitaire\s*(?:hors\s*(?:tva|taxe)|ht)\s*[:=]?\s*(\d+[.,]\d+)\s*€?\s*(?:\/\s*m[²2])?/i) ||
    priceText.match(/(?:prix\s*(?:unitaire)?(?:\s*ht)?|tarif)\s*[:=]?\s*(\d+[.,]\d+)\s*€?\s*(?:ht)?\s*(?:\/\s*m[²2])?/i) ||
    priceText.match(/eenheidsprijs\s*(?:excl\.?\s*btw)?\s*[:=]?\s*(\d+[.,]\d+)\s*€?\s*(?:\/\s*m[²2])?/i) ||
    priceText.match(/(?:einzelpreis|stückpreis)\s*(?:(?:ohne|exkl\.?)\s*(?:mwst|ust))?\s*[:=]?\s*(\d+[.,]\d+)\s*€?\s*(?:\/\s*m[²2])?/i) ||
    priceText.match(/(?:precio\s*unitario|prezzo\s*unitario|unit\s*price)\s*(?:(?:sin|excl\.?|ex)\s*(?:iva|iva|vat))?\s*[:=]?\s*(\d+[.,]\d+)\s*€?\s*(?:\/\s*m[²2])?/i) ||
    priceText.match(/(\d+[.,]\d+)\s*€\s*(?:ht\s*)?(?:\/\s*m[²2]|par\s*m[²2])/i) ||
    priceText.match(/(\d+[.,]\d+)\s*€\s*\/\s*m[²2]/i);

  // Extraire la surface — patterns variés (supporte entiers et décimaux, FR/NL/DE/ES/IT/EN)
  const surfaceMatch =
    priceText.match(/(?:surface|oppervlakte|fläche|superficie|area)\s*(?:totale?|unitaire|per\s*eenheid|gesamt)?\s*[:=]?\s*(\d+[.,]?\d*)\s*m[²2]/i) ||
    priceText.match(/(?:totale?\s*(?:oppervlakte|surface|fläche|superficie))\s*[:=]?\s*(\d+[.,]?\d*)\s*m[²2]/i) ||
    priceText.match(/(\d+[.,]?\d*)\s*m[²2]\s*(?:au total|total|totaal|gesamt|in totale)?/i);

  // Extraire le total HT — patterns variés (FR/NL/DE/ES/IT/EN)
  const totalHTMatch =
    priceText.match(/(?:total|montant)\s*(?:hors\s*(?:tva|taxe)|ht)\s*[:=]?\s*(\d+[.,]\d+)\s*€/i) ||
    priceText.match(/(?:total|montant)\s*ht\s*[:=]?\s*(\d+[.,]\d+)\s*€/i) ||
    priceText.match(/(?:totaal|bedrag)\s*(?:excl\.?\s*btw)\s*[:=]?\s*(\d+[.,]\d+)\s*€/i) ||
    priceText.match(/(?:gesamt|summe)\s*(?:(?:ohne|exkl\.?)\s*(?:mwst|ust)|netto)\s*[:=]?\s*(\d+[.,]\d+)\s*€/i) ||
    priceText.match(/(?:total|importe)\s*(?:sin\s*iva|excl\.?\s*iva)\s*[:=]?\s*(\d+[.,]\d+)\s*€/i) ||
    priceText.match(/(?:total|importo)\s*(?:esclusa?\s*iva)\s*[:=]?\s*(\d+[.,]\d+)\s*€/i);

  // Extraire le montant TTC — patterns variés (FR/NL/DE/ES/IT/EN)
  const totalTTCMatch =
    priceText.match(/(?:total|montant)\s*ttc\s*[:=]?\s*(\d+[.,]\d+)\s*€/i) ||
    priceText.match(/ttc\s*[:=]?\s*(\d+[.,]\d+)\s*€/i) ||
    priceText.match(/montant\s*ttc\s*[:=—–-]\s*(\d+[.,]\d+)\s*€/i) ||
    priceText.match(/(?:bedrag|totaal)\s*(?:incl\.?\s*btw)\s*[:=]?\s*(\d+[.,]\d+)\s*€/i) ||
    priceText.match(/(?:gesamt|summe)\s*(?:(?:inkl\.?|mit)\s*(?:mwst|ust)|brutto)\s*[:=]?\s*(\d+[.,]\d+)\s*€/i) ||
    priceText.match(/(?:total|importe)\s*(?:con\s*iva|incl\.?\s*iva)\s*[:=]?\s*(\d+[.,]\d+)\s*€/i) ||
    priceText.match(/(?:total|importo)\s*(?:inclusa?\s*iva)\s*[:=]?\s*(\d+[.,]\d+)\s*€/i);

  // Extraire le taux de TVA depuis le texte (AVANT le calcul des prix)
  const tvaRateMatch =
    priceText.match(/(?:TVA|tva|IVA|TVA applicable)[^)]*?\(?\s*(\d+(?:[.,]\d+)?)\s*%/i) ||
    priceText.match(/(?:taux\s*(?:de\s*)?(?:TVA|tva|IVA))[^)]*?[:=]?\s*(\d+(?:[.,]\d+)?)\s*%/i) ||
    priceText.match(/TVA\s*\(\s*(\d+(?:[.,]\d+)?)\s*%\s*\)/i) ||
    priceText.match(/(\d+(?:[.,]\d+)?)\s*%\s*(?:TVA|tva|IVA)/i) ||
    priceText.match(/(?:btw|BTW)\s*\(?\s*(\d+(?:[.,]\d+)?)\s*%/i) ||
    priceText.match(/(\d+(?:[.,]\d+)?)\s*%\s*(?:btw|BTW)/i) ||
    priceText.match(/(?:MwSt|USt|Mwst)\s*\(?\s*(\d+(?:[.,]\d+)?)\s*%/i) ||
    priceText.match(/(\d+(?:[.,]\d+)?)\s*%\s*(?:MwSt|USt|Mwst)/i);

  // Extraire les accessoires depuis le texte (FR/NL/DE/ES/IT/EN)
  // Pattern : "Label – Quantité: N → N × prix € = total €" ou "Label : N × prix €"
  const accessoryLines: QuoteLine[] = [];
  const accessoryPatterns = [
    // NL: "Bevestigingskit – Hoeveelheid: 2 → 2 × 24,71 € = 49,42 €"
    /^(.+?)\s*[–—-]\s*(?:hoeveelheid|aantal|quantité|cantidad|quantità|quantity|anzahl|menge)\s*[:=]?\s*(\d+)\s*→?\s*\d+\s*[×x]\s*(\d+[.,]\d+)\s*€/gim,
    // FR: "Kit de fixation : 2 × 24,71 €"
    /^(.+?)\s*[:=]\s*(\d+)\s*[×x]\s*(\d+[.,]\d+)\s*€/gim,
  ];
  for (const pattern of accessoryPatterns) {
    let accMatch;
    while ((accMatch = pattern.exec(priceText)) !== null) {
      const label = accMatch[1].trim();
      // Ignorer si c'est une ligne de filet/net/produit principal
      if (/(?:filet|net\b|netz|red\b|rete\b|voile|camouflag)/i.test(label)) continue;
      // Ignorer si c'est un total/transport
      if (/(?:total|transport|verzend|livraison|versand|envío|spedizione)/i.test(label)) continue;
      accessoryLines.push({
        type: 'accessory',
        label,
        quantity: parseInt(accMatch[2], 10),
        unitPrice: parseNumber(accMatch[3]).toFixed(2),
        unit: 'piece',
      });
    }
    if (accessoryLines.length > 0) break;
  }
  console.log('[extractQuoteData] accessoryLines:', accessoryLines.length, accessoryLines.map(a => `${a.label} x${a.quantity} @ ${a.unitPrice}`));

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
  const dimMatch = priceText.match(/(\d+[.,]?\d*)\s*[x×]\s*(\d+[.,]?\d*)\s*m/i);

  // Extraire matière/finition et couleur
  const matiereMatch = priceText.match(/(?:matière|finition|type|materia[le]?|material|contour|contorno|câble|cable|polyester|tipo)\s*[:=]?\s*([A-Za-zÀ-ÿ\s]+?)(?:\n|$|,)/i);
  const couleurMatch = priceText.match(/(?:couleur|coloris|couleurs|color(?!\w)|colore|farbe|kleur)\s*[:=]?\s*([A-Za-zÀ-ÿ]+(?:\s+[A-Za-zÀ-ÿ]+)?)(?:\n|$|,|—)/i);

  // Extraire la quantité (nombre de filets commandés)
  const qtyMatch = priceText.match(/(?:quantité|qté|qty)\s*[:=]?\s*(\d+)/i);
  const orderQty = qtyMatch ? parseInt(qtyMatch[1], 10) : 1;

  // Déterminer si c'est un produit catalogue (TTC) ou du sur mesure (HT/m²)
  const isCatalogue = !!(totalTTCMatch && !surfaceMatch && !prixUnitaireMatch);

  // Construire le label
  const couleur = couleurMatch ? couleurMatch[1].trim() : '';
  const matiere = matiereMatch ? matiereMatch[1].trim() : '';
  const dimLabel = dimMatch ? `${dimMatch[1].replace(',', '.')}x${dimMatch[2].replace(',', '.')} m` : '';

  console.log('[extractQuoteData] isCatalogue:', isCatalogue);

  // ─── Détecter multi-filets (Filet n°1, Filet n°2, etc.) ───
  // Détecter multi-filets : "Filet n°1 — Triangle 6,9 x 6,9 x 3,8 m" + "Surface : 12,60 m²"
  const multiFilets: { num: string; dims: string; surface: number }[] = [];
  const filetHeaders = [...priceText.matchAll(/(?:filet|netz|red|rete|net|voile)\s*(?:n[°º.]?\s*)?(\d+)\s*[—–-]\s*([^\n]+)/gi)];
  for (const h of filetHeaders) {
    const num = h[1];
    const desc = h[2].trim();
    // Extraire dimensions (2 ou 3 valeurs x)
    const dimMatch = desc.match(/([\d.,]+\s*[x×]\s*[\d.,]+(?:\s*[x×]\s*[\d.,]+)?)\s*m/i);
    const dims = dimMatch ? dimMatch[1].replace(/\s/g, '').replace(/,/g, '.') : '';
    // Chercher la surface après ce header (dans les 300 chars suivants)
    const afterHeader = priceText.substring(h.index! + h[0].length, h.index! + h[0].length + 300);
    const surfaceMatch = afterHeader.match(/surface\s*(?:unitaire|totale)?\s*[:=]?\s*(\d+[.,]\d*)\s*m[²2]/i);
    if (surfaceMatch) {
      multiFilets.push({ num, dims, surface: parseNumber(surfaceMatch[1]) });
    }
  }
  const isMultiFilet = multiFilets.length > 1;
  console.log('[extractQuoteData] multi-filets:', isMultiFilet ? multiFilets.length : 'non', multiFilets);

  // Déterminer le prix unitaire HT/m² (commun à tous les filets)
  // PRIORITÉ : prix unitaire explicite > (total HT - accessoires) / surface > total TTC / surface
  // IMPORTANT : ne jamais recalculer le prix unitaire depuis le total global quand il y a des accessoires
  const accessoiresTotalHT = accessoryLines.reduce((s, l) => s + l.quantity * parseNumber(l.unitPrice), 0);
  let unitPrice: string;
  if (isCatalogue) {
    const ttc = parseNumber(totalTTCMatch![1]);
    const ht = ttc / vatMultiplier;
    unitPrice = (ht / orderQty).toFixed(2);
    console.log('[extractQuoteData] catalogue TTC→HT:', { ttc, vatMultiplier, htUnit: unitPrice, qty: orderQty });
  } else if (prixUnitaireMatch) {
    // Prix unitaire HT explicite = priorité absolue pour le sur mesure
    unitPrice = parseNumber(prixUnitaireMatch[1]).toFixed(2);
    console.log('[extractQuoteData] prix unitaire explicite:', unitPrice);
  } else if (totalHTMatch && surfaceMatch) {
    // Soustraire les accessoires du total HT avant de diviser par la surface
    const totalHT = parseNumber(totalHTMatch[1]);
    const netHT = totalHT - accessoiresTotalHT;
    unitPrice = (netHT / parseNumber(surfaceMatch[1])).toFixed(2);
    console.log('[extractQuoteData] totalHT - accessoires:', { totalHT, accessoiresTotalHT, netHT, unitPrice });
  } else if (totalTTCMatch && surfaceMatch) {
    const ttc = parseNumber(totalTTCMatch[1]);
    const ht = ttc / vatMultiplier;
    const netHT = ht - accessoiresTotalHT;
    const surf = parseNumber(surfaceMatch[1]);
    unitPrice = (netHT / surf).toFixed(2);
  } else if (totalHTMatch) {
    unitPrice = parseNumber(totalHTMatch[1]).toFixed(2);
  } else {
    return null;
  }

  // ─── Labels traduits par langue de boutique ───
  const storeLang = context?.storeCode ? (STORE_LABEL_LANG[context.storeCode] || 'fr') : 'fr';
  const labelTemplates: Record<string, { surMesure: string; surMesureMatiere: (m: string) => string; catalogue: string; devis: string; standard: string }> = {
    fr: { surMesure: 'Filet de camouflage renforcé sur mesure', surMesureMatiere: (m) => `Filet de camouflage renforcé ${m.toLowerCase()}`, catalogue: 'Produit catalogue', devis: 'Devis', standard: 'filet standard' },
    nl: { surMesure: 'Camouflagenet versterkt op maat', surMesureMatiere: (m) => `Camouflagenet versterkt ${m.toLowerCase()}`, catalogue: 'Catalogusproduct', devis: 'Offerte', standard: 'net standaard' },
    de: { surMesure: 'Tarnnetz verstärkt nach Maß', surMesureMatiere: (m) => `Tarnnetz verstärkt ${m.toLowerCase()}`, catalogue: 'Katalogprodukt', devis: 'Angebot', standard: 'Tarnnetz Standard' },
    es: { surMesure: 'Red de camuflaje reforzada a medida', surMesureMatiere: (m) => `Red de camuflaje reforzada ${m.toLowerCase()}`, catalogue: 'Producto catálogo', devis: 'Presupuesto', standard: 'red estándar' },
    it: { surMesure: 'Rete mimetica rinforzata su misura', surMesureMatiere: (m) => `Rete mimetica rinforzata ${m.toLowerCase()}`, catalogue: 'Prodotto catalogo', devis: 'Preventivo', standard: 'rete standard' },
  };
  const tpl = labelTemplates[storeLang] || labelTemplates.fr;

  // ─── Construire les lignes produit ───
  const lines: QuoteLine[] = [];

  if (isMultiFilet && !isCatalogue) {
    // Multi-filets sur mesure : une ligne par filet
    const finition = matiere ? tpl.surMesureMatiere(matiere) : tpl.surMesure;
    for (const filet of multiFilets) {
      const filetDim = `${filet.dims} m`;
      const filetLabel = [couleur, filetDim, finition].filter(Boolean).join(' - ');
      lines.push({
        type: 'product',
        label: filetLabel,
        quantity: filet.surface,
        unitPrice,
        unit: 'm2',
      });
    }
    console.log('[extractQuoteData] multi-filets lines:', lines.length, 'total m²:', multiFilets.reduce((s, f) => s + f.surface, 0));
  } else if (isCatalogue) {
    // Produit catalogue
    let label: string;
    const productLineMatch = priceText.match(/(?:^|\n)\s*((?:filet|red|rete|net|netz|toile|coco|voile|parasol|rideau|brise-vue|cortina|tenda|Schutznetz|camouflagenet)[^\n]{5,80})/im);
    if (productLineMatch) {
      label = productLineMatch[1].trim()
        .replace(/\s*[-—–]\s*(?:quantité|cantidad|qty|anzahl|aantal|quantità)\s*[:=]?\s*\d+/i, '')
        .replace(/\s*[-—–]\s*\d+[.,]\d+\s*€.*/i, '')
        .trim();
    } else {
      const parts = [dimLabel, couleur, matiere].filter(Boolean);
      label = parts.length > 0 ? parts.join(' — ') : tpl.catalogue;
    }
    lines.push({
      type: 'product',
      label,
      quantity: orderQty,
      unitPrice,
      unit: 'piece',
    });
  } else {
    // Sur mesure simple (1 filet)
    const finition = matiere ? tpl.surMesureMatiere(matiere) : tpl.surMesure;
    const labelParts = [couleur, dimLabel, finition].filter(Boolean);
    const label = labelParts.join(' - ') || tpl.surMesure;
    const quantity = surfaceMatch ? parseNumber(surfaceMatch[1]) : 1;
    lines.push({
      type: 'product',
      label,
      quantity,
      unitPrice,
      unit: 'm2',
    });
  }

  // Ajouter les accessoires détectés
  for (const acc of accessoryLines) {
    lines.push(acc);
  }

  // Livraison toujours incluse sur sur mesure → AUCUNE ligne transport dans le devis.
  // (Avant : on poussait une ligne transport 19,99 € + une remise -19,99 € pour
  //  visualiser "offert" dans le PDF. Désormais : zéro ligne transport, point.)

  // Construire le sujet
  const surMesureLabel = storeLang === 'fr' ? 'filet sur mesure' : (storeLang === 'nl' ? 'net op maat' : (storeLang === 'de' ? 'Tarnnetz nach Maß' : (storeLang === 'es' ? 'red a medida' : (storeLang === 'it' ? 'rete su misura' : 'custom net'))));
  const subject = isCatalogue
    ? `${tpl.devis} ${tpl.standard}${dimLabel ? ' ' + dimLabel : ''}`
    : `${tpl.devis} ${surMesureLabel}${isMultiFilet ? ` ${multiFilets.length}` : (dimLabel ? ' ' + dimLabel : '')}`;

  // Construire le customer depuis le contexte + texte

  // Helper : extraire un champ de formulaire Shopify (label sur même ligne OU ligne suivante)
  // Supporte : "Label: valeur" et "Label:\nvaleur"
  const getField = (label: RegExp): string => {
    const m = text.match(new RegExp(label.source + '\\s*[:：]\\s*\\n?\\s*([^\\n]+)', 'i'));
    if (!m) return '';
    // Limiter à 100 chars et couper au premier mot-clé de formulaire parasite
    let val = m[1].trim().substring(0, 100);
    // Couper si on détecte un label de formulaire suivant (Adresse, Email, Téléphone, etc.)
    val = val.replace(/\s+(?:adresse|e-?mail|tél|prénom|nom|ville|code postal|pays|forme|type|taille|couleur|quantité|corps|numéro|n°|phone|dirección|indirizzo|address)\s*(?:[:：(]|de\s).*/i, '');
    return val.trim();
  };

  // Email client : vient du SDK (replyTo.handle), déjà résolu dans PluginMain
  const finalEmail = context?.customerEmail || '';
  console.log('[extractQuoteData] final email (from SDK replyTo):', finalEmail);

  // Nom client : le SDK Front (replyTo.contact.name) est la source la plus fiable
  const nameFromSDK = context?.customerName || '';
  // Extraire le nom depuis le corps du mail (fallback uniquement si le SDK n'a pas de nom)
  // Word boundaries (\b) pour éviter de matcher "Achternaam" au lieu de "Naam"
  const nameFromBody = getField(/(?:\bname\b|\bnom\b(?:\s*complet)?|\bnombre\b(?:\s*completo)?|\bnaam\b|\bnome\b)/);
  // Ignorer les noms Shopify ou parasites
  const isJunkName = (n: string) => !n || /shopify|filet.*camouflage|noreply|camuflaje|camouflage|numéro|telefon|téléphone|phone|email|adresse|address|dirección|instal/i.test(n);
  // Priorité SDK > corps du mail
  const finalName = !isJunkName(nameFromSDK) ? nameFromSDK : !isJunkName(nameFromBody) ? nameFromBody : '';

  let customer: QuoteCustomer | undefined;

  // Détecter la raison sociale (FR/ES/DE/NL/IT)
  // Exclure "Btw Nummer (Indien Bedrijf)" qui est un label de formulaire, pas un nom d'entreprise
  const raisonSocialeRaw = getField(/(?:raison\s*sociale|entreprise|société|empresa|razón\s*social|firma|unternehmen|\bbedrijf\b|azienda|ditta)(?:\s*\([^)]*\))?(?:\s*\/[^:]*)?/);
  // Filtrer les fausses raisons sociales (labels de formulaire, numéros de téléphone, etc.)
  const isJunkCompany = (n: string) => !n || /^numéro|^téléphone|^phone|^email|^adresse|^n°|^\d{6,}|^0\d|^btw|^achternaam|^indien/i.test(n);
  const companyName = isJunkCompany(raisonSocialeRaw) ? '' : raisonSocialeRaw;
  const isCompany = companyName.length > 0;

  // Chercher "Nom et prénom" / "Nombre" / "Name" (même ligne ou ligne suivante)
  // Word boundaries pour éviter les faux positifs (ex: "Achternaam" ne doit pas matcher "naam")
  const nomPrenomRaw = getField(/(?:nom\s*(?:et\s*)?prénom|prénom\s*(?:et\s*)?nom|nombre(?:\s*(?:y\s*)?apellidos?)?|nombre\s*completo|vor-?\s*und\s*nachname|\bnaam\b|nome(?:\s*e\s*cognome)?)/);
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
  // Mots-clés de formulaire à exclure comme nom de ville
  const formLabels = /^(?:pays|country|ciudad|stadt|land|città|paese|ville|code|postal|email|phone|tél|form|type|corps|quantité)$/i;

  const cpVilleMatch = (() => {
    for (const line of text.split('\n')) {
      // Pattern "CP 07141, Marratxí" ou "C.P. 07141 Marratxí"
      const cpES = line.match(/(?:CP|C\.?P\.?)\s*(\d{4,5})[,\s]+([A-ZÀ-Ü][a-zà-ÿ]+(?:[\s-][A-Za-zÀ-ÿ]+)*)/i);
      if (cpES && !formLabels.test(cpES[2])) return cpES;
      // Pattern générique "12345 Ville" (FR/DE/IT/ES)
      const m = line.match(/\b(\d{4,5})\s+([A-ZÀ-Ü][a-zà-ÿ]+(?:[\s-][A-Za-zÀ-ÿ]+)*)/);
      if (m && !formLabels.test(m[2])) return m;
      // Pattern NL "1234 AB Ville"
      const nl = line.match(/\b(\d{4}\s*[A-Z]{2})\s+([A-ZÀ-Ü][a-zà-ÿ]+(?:[\s-][A-Za-zÀ-ÿ]+)*)/);
      if (nl && !formLabels.test(nl[2])) return nl;
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
    let rue = rueMatch?.[1]?.trim() || adresseLabelMatch?.[1]?.trim() || '';
    // Nettoyer : couper aux labels de formulaire parasites (Ville:, Code Postal:, Pays:, etc.)
    rue = rue.replace(/\s+(?:ville|code\s*postal|pays|city|postal\s*code|country|ciudad|código\s*postal|país|stadt|plz|land|città|cap|paese)\s*[:：].*/i, '').trim();
    // Extraire ville depuis "Ville: xxx" si cpVilleMatch n'a pas de ville
    let city = cpVilleMatch ? cpVilleMatch[2].trim() : '';
    if (!city || formLabels.test(city)) {
      const villeMatch = text.match(/(?:ville|city|ciudad|stadt|città)\s*[:：]\s*([^\n:]{1,40})/i);
      city = villeMatch ? villeMatch[1].trim() : '';
      // Couper au premier mot parasite ou début de phrase
      city = city.replace(/\s+(?:code|postal|pays|country|email|phone|tél|form|type|corps|quantité|indicatif|souhait|voulez|merci|n'hésitez|pour|comment|nous).*/i, '').trim();
    }
    // Extraire pays depuis "Pays: xxx" et convertir en code ISO
    let country = customer.address?.country || '';
    if (!country) {
      const paysMatch = text.match(/(?:pays|country|país|land|paese)\s*[:：]\s*([A-Za-zÀ-ÿ]+)/i);
      if (paysMatch) {
        const paysName = paysMatch[1].trim().toLowerCase();
        // Convertir nom de pays → code ISO
        const countryCode = detectCountryFromText(paysName);
        country = countryCode || paysName.toUpperCase().substring(0, 2);
      }
    }
    if (rue || cpVilleMatch || city) {
      customer.address = {
        address: rue,
        postalCode: cpVilleMatch ? cpVilleMatch[1] : '',
        city,
        country,
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
    _fullText: text,
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
  const defaultCountry = STORE_DEFAULT_COUNTRY[storeCode] || 'FR';
  const extractedRate = quote.extractedVatPercent;

  // 1. Pays depuis le n° TVA intra du client
  const vatCountry = quote.customer?.vatNumber?.match(/^([A-Z]{2})/)?.[1];
  // 2. Pays depuis l'adresse (détection dans le texte)
  const addressCountry = quote.customer?.address?.country;
  // 3. Pays résolu depuis le taux TVA + texte du devis (détecte "Autriche", "Österreich", etc.)
  const fullText = quote.lines.map(l => `${l.label} ${l.description || ''}`).join(' ') +
    ` ${quote.customer?.address?.address || ''} ${quote.customer?.address?.city || ''}`;
  const rateCountry = extractedRate !== null && extractedRate !== undefined
    ? resolveCountryFromVatRate(extractedRate, quote._fullText || fullText, defaultCountry)
    : null;

  const customerCountry = vatCountry || addressCountry || rateCountry || defaultCountry;

  // Déterminer le code TVA Pennylane
  const vatCode = extractedRate !== null && extractedRate !== undefined
    ? toPennylaneVatCode(extractedRate, extractedRate === 0 ? 'FR' : customerCountry)
    : toPennylaneVatCode(VAT_RATES_BY_COUNTRY[defaultCountry] || 20, defaultCountry);

  console.log('[formatQuotePayload] country:', customerCountry, 'vatCode:', vatCode, 'storeCode:', storeCode, 'extractedRate:', extractedRate);

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
      unit: l.unit,
    })),
    subject: quote.subject,
    inboxName,
  };
}
