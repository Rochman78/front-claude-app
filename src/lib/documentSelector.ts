/**
 * Sélection intelligente des documents de référence selon le contenu du mail client.
 * Analyse les mots-clés (multi-langues) pour ne charger que les docs pertinents dans le contexte Claude.
 */

interface FileEntry {
  name: string;
  content: string;
  shared: boolean;
}

const CATEGORIES: { keywords: string[]; docs: string[] }[] = [
  {
    keywords: [
      // FR
      'devis', 'sur mesure', 'sur-mesure', 'dimensions', 'personnalisé', 'taille spéciale', 'mesure', 'mètres', 'm²',
      // EN
      'quote', 'custom', 'custom-made', 'bespoke',
      // ES
      'presupuesto', 'medida', 'a medida', 'personalizado', 'dimensiones',
      // DE
      'angebot', 'maßanfertigung', 'maßgefertigt', 'sondermaß', 'abmessungen',
      // NL
      'offerte', 'op maat', 'maatwerkk', 'afmetingen',
      // IT
      'preventivo', 'su misura', 'personalizzato', 'dimensioni',
    ],
    docs: ['devis-sur-mesure', 'obligations-tva', 'format-json-devis', 'catalogue'],
  },
  {
    keywords: [
      'retour', 'retourner', 'rembourser', 'remboursement', 'échange', 'échanger', 'rétractation', 'annuler',
      'return', 'refund', 'exchange',
      'devolución', 'devolver', 'reembolso', 'cambio', 'desistimiento',
      'rückgabe', 'rücksendung', 'erstattung', 'umtausch', 'widerruf',
      'retour', 'terugsturen', 'terugbetaling', 'ruil',
      'reso', 'restituire', 'rimborso', 'cambio', 'recesso',
    ],
    docs: ['POLITIQUE DE RETOURS', 'template-echange-erreur-client'],
  },
  {
    keywords: [
      'livraison', 'colis', 'suivi', 'expédition', 'reçu', 'pas reçu', 'transporteur', 'mondial relay', 'colissimo', 'chronopost',
      'tracking', 'delivery', 'shipping', 'parcel',
      'envío', 'paquete', 'seguimiento', 'entrega', 'no recibido',
      'lieferung', 'paket', 'sendungsverfolgung', 'versand', 'nicht erhalten',
      'levering', 'pakket', 'verzending', 'niet ontvangen',
      'consegna', 'pacco', 'spedizione', 'non ricevuto',
    ],
    docs: ['POLITIQUE EXPEDITION', 'template-colis-non-recu'],
  },
  {
    keywords: [
      'colis non reçu', 'pas reçu', 'jamais reçu', 'perdu', 'attestation',
      'not received', 'lost',
      'no recibido', 'perdido', 'declaración jurada',
      'nicht erhalten', 'verloren', 'eidesstattliche',
      'niet ontvangen', 'verloren',
      'non ricevuto', 'perso',
    ],
    docs: ['attestation', 'template-colis-non-recu'],
  },
  {
    keywords: [
      'garantie', 'défaut', 'endommagé', 'cassé', 'déchiré', 'abîmé', 'usure', 'usé', 'décoloré', 'troué',
      'warranty', 'damaged', 'broken', 'torn',
      'garantía', 'defecto', 'dañado', 'roto', 'desgaste',
      'garantie', 'defekt', 'beschädigt', 'gerissen', 'abgenutzt', 'gewährleistung',
      'garantie', 'defect', 'beschadigd', 'gescheurd',
      'garanzia', 'difetto', 'danneggiato', 'rotto', 'usura',
    ],
    docs: ['template-garantie-diagnostic'],
  },
  {
    keywords: [
      'produit', 'filet', 'voile', 'taille', 'couleur', 'installation', 'fixer', 'fixation', 'mât', 'corde', 'accessoire',
      'product', 'net', 'sail', 'size', 'color',
      'producto', 'red', 'toldo', 'tamaño', 'color', 'instalación', 'fijación',
      'produkt', 'netz', 'tarnnetz', 'größe', 'farbe', 'installation', 'befestigung',
      'product', 'net', 'maat', 'kleur', 'installatie', 'bevestiging',
      'prodotto', 'rete', 'tenda', 'taglia', 'colore', 'installazione', 'fissaggio',
      'toile', 'coco', 'parasol', 'rideau', 'brise-vue',
    ],
    docs: ['catalogue', 'FT-Filets', 'FT-Coco', 'Fiches_Techniques'],
  },
  {
    keywords: [
      'tva', 'facture', 'ht', 'hors taxe', 'professionnel', 'entreprise', 'société', 'siret', 'intracommunautaire',
      'vat', 'invoice', 'tax',
      'iva', 'factura', 'impuesto',
      'mwst', 'rechnung', 'steuer', 'umsatzsteuer',
      'btw', 'factuur', 'belasting',
      'iva', 'fattura', 'imposta',
    ],
    docs: ['obligations-tva'],
  },
  {
    keywords: [
      'cgv', 'conditions', 'droit', 'légal', 'rétractation', 'médiation',
      'terms', 'legal',
      'condiciones', 'legal', 'desistimiento', 'mediación',
      'agb', 'recht', 'widerruf', 'schlichtung',
      'voorwaarden', 'juridisch', 'herroeping',
      'condizioni', 'legale', 'recesso', 'mediazione',
    ],
    docs: ['CGV'],
  },
];

/**
 * Retourne la liste des noms de documents pertinents selon le contenu du mail.
 * Les noms retournés sont des PATTERNS partiels (ex: 'catalogue') qui matchent
 * n'importe quel fichier contenant ce pattern (catalogue-LFC.txt, catalogue-RED.txt, etc.)
 */
export function selectDocumentNames(emailContent: string): string[] {
  const text = emailContent.toLowerCase();

  const matched = new Set<string>();
  for (const cat of CATEGORIES) {
    if (cat.keywords.some((kw) => text.includes(kw))) {
      cat.docs.forEach((d) => matched.add(d));
    }
  }

  // Fallback : si aucun mot-clé détecté, inclure catalogue + CGV
  if (matched.size === 0) {
    ['catalogue', 'CGV'].forEach((d) => matched.add(d));
  }

  return Array.from(matched);
}

/**
 * Match un nom de fichier contre un pattern de document.
 * Match partiel case-insensitive : "catalogue" matche "catalogue-RED.txt", "catalogue-LFC.txt", etc.
 */
function nameMatches(fileName: string, docPattern: string): boolean {
  return fileName.toLowerCase().includes(docPattern.toLowerCase());
}

/**
 * Filtre les fichiers agent + partagés pour ne garder que les docs pertinents.
 */
export function filterRelevantFiles(allFiles: FileEntry[], relevantDocNames: string[]): FileEntry[] {
  return allFiles.filter((f) =>
    relevantDocNames.some((docPattern) => nameMatches(f.name, docPattern))
  );
}

/**
 * Construit le contexte documents formaté pour injection dans le message Claude.
 */
export function buildDocumentsText(files: FileEntry[]): string {
  return files.map((f) => f.shared ? `[Partagé: ${f.name}]\n${f.content}` : `[${f.name}]\n${f.content}`).join('\n\n');
}
