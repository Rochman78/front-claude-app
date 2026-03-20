/**
 * Sélection intelligente des documents de référence selon le contenu du mail client.
 * Analyse les mots-clés pour ne charger que les docs pertinents dans le contexte Claude.
 */

interface FileEntry {
  name: string;
  content: string;
  shared: boolean;
}

const CATEGORIES: { keywords: string[]; docs: string[] }[] = [
  {
    keywords: ['devis', 'sur mesure', 'sur-mesure', 'dimensions', 'personnalisé', 'taille spéciale', 'mesure', 'mètres', 'm²', 'quote', 'custom', 'custom-made', 'bespoke'],
    docs: ['devis-sur-mesure-base-documentaire.txt', 'obligations-tva-zephyr.docx', 'format-json-devis.txt', 'catalogue-LFC.txt'],
  },
  {
    keywords: ['retour', 'retourner', 'rembourser', 'remboursement', 'échange', 'échanger', 'rétractation', 'annuler', 'return', 'refund', 'exchange'],
    docs: ['POLITIQUE DE RETOURS.docx', 'template-echange-erreur-client.txt'],
  },
  {
    keywords: ['livraison', 'colis', 'suivi', 'expédition', 'reçu', 'pas reçu', 'transporteur', 'mondial relay', 'colissimo', 'chronopost', 'tracking', 'delivery', 'shipping', 'parcel'],
    docs: ['POLITIQUE EXPEDITION.docx', 'template-colis-non-recu.txt'],
  },
  {
    keywords: ['colis non reçu', 'pas reçu', 'jamais reçu', 'perdu', 'attestation'],
    docs: ['attestation-filet.pdf', 'template-colis-non-recu.txt'],
  },
  {
    keywords: ['garantie', 'défaut', 'endommagé', 'cassé', 'déchiré', 'abîmé', 'usure', 'usé', 'décoloré', 'troué', 'warranty', 'damaged', 'broken', 'torn'],
    docs: ['template-garantie-diagnostic.txt'],
  },
  {
    keywords: ['produit', 'filet', 'voile', 'taille', 'couleur', 'installation', 'fixer', 'fixation', 'mât', 'corde', 'accessoire', 'product', 'net', 'sail', 'size', 'color'],
    docs: ['catalogue-LFC.txt', 'FT-Filets-LFC.pdf', 'FT-Coco-LFC.pdf', 'Fiches_Techniques_Accessoires.pdf'],
  },
  {
    keywords: ['tva', 'facture', 'ht', 'hors taxe', 'professionnel', 'entreprise', 'société', 'siret', 'intracommunautaire', 'vat', 'invoice', 'tax'],
    docs: ['obligations-tva-zephyr.docx'],
  },
  {
    keywords: ['cgv', 'conditions', 'droit', 'légal', 'rétractation', 'médiation', 'terms', 'legal'],
    docs: ['CGV.docx'],
  },
];

/**
 * Retourne la liste des noms de documents pertinents selon le contenu du mail.
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
    ['catalogue-LFC.txt', 'CGV.docx'].forEach((d) => matched.add(d));
  }

  return Array.from(matched);
}

function nameMatches(fileName: string, docName: string): boolean {
  return fileName.toLowerCase().includes(docName.toLowerCase()) || docName.toLowerCase().includes(fileName.toLowerCase());
}

/**
 * Filtre les fichiers agent + partagés pour ne garder que les docs pertinents.
 * Seuls les fichiers explicitement sélectionnés sont inclus (plus de fichiers "unknown" automatiques).
 */
export function filterRelevantFiles(allFiles: FileEntry[], relevantDocNames: string[]): FileEntry[] {
  return allFiles.filter((f) =>
    relevantDocNames.some((docName) => nameMatches(f.name, docName))
  );
}

/**
 * Construit le contexte documents formaté pour injection dans le message Claude.
 */
export function buildDocumentsText(files: FileEntry[]): string {
  return files.map((f) => f.shared ? `[Partagé: ${f.name}]\n${f.content}` : `[${f.name}]\n${f.content}`).join('\n\n');
}
