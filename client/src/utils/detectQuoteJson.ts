/**
 * Détecte un bloc JSON devis dans la réponse Claude.
 * Claude génère parfois un JSON structuré pour créer un devis Pennylane.
 * Le JSON est entouré de ```json ... ``` ou directement dans le texte.
 */
export interface QuoteData {
  customer?: {
    name?: string;
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
    type?: 'company' | 'individual';
    address?: { street?: string; zipCode?: string; city?: string; country?: string };
    vatNumber?: string;
  };
  lines?: {
    type?: 'product' | 'free';
    label: string;
    quantity: number;
    unitPrice: number;
    vatRate?: string;
    description?: string;
  }[];
  subject?: string;
  deadline?: string;
  freeText?: string;
}

/**
 * Cherche un JSON devis dans le texte. Retourne le premier JSON valide trouvé
 * qui contient au moins un champ `lines` (signature d'un devis).
 */
export function detectQuoteJson(text: string): QuoteData | null {
  // Chercher dans les blocs ```json ... ```
  const codeBlockRegex = /```json\s*([\s\S]*?)```/g;
  let match;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    const parsed = tryParseQuote(match[1]);
    if (parsed) return parsed;
  }

  // Chercher un objet JSON brut { ... } contenant "lines"
  const braceRegex = /\{[\s\S]*?"lines"[\s\S]*?\}(?=\s|$)/g;
  while ((match = braceRegex.exec(text)) !== null) {
    const parsed = tryParseQuote(match[0]);
    if (parsed) return parsed;
  }

  return null;
}

function tryParseQuote(raw: string): QuoteData | null {
  try {
    const data = JSON.parse(raw.trim());
    if (data && Array.isArray(data.lines) && data.lines.length > 0) {
      return data as QuoteData;
    }
  } catch {
    // JSON invalide, on continue
  }
  return null;
}

/**
 * Calcule le total TTC d'un devis à partir des lignes.
 */
export function computeTotal(lines: QuoteData['lines']): { totalHT: number; totalTTC: number } {
  if (!lines) return { totalHT: 0, totalTTC: 0 };

  let totalHT = 0;
  for (const line of lines) {
    totalHT += line.quantity * line.unitPrice;
  }

  // Taux TVA par défaut : 20%
  const defaultVatRate = 0.2;
  const totalTTC = totalHT * (1 + defaultVatRate);

  return {
    totalHT: Math.round(totalHT * 100) / 100,
    totalTTC: Math.round(totalTTC * 100) / 100,
  };
}
