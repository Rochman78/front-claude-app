/**
 * Configuration centralisée des 8 boutiques Zephyr O.S.C.
 * Source unique pour les mappings boutique → Pennylane, langues, etc.
 */

export interface StoreConfig {
  code: string;
  name: string;
  email: string;
  defaultLang: string;
  pennylaneTemplateId: number;
  inboxMatchPattern: string; // Pattern pour matcher le nom d'inbox FrontApp
}

export const STORES: StoreConfig[] = [
  { code: 'LFC',  name: 'Le Filet de Camouflage',  email: 'serviceclient@le-filet-de-camouflage.fr', defaultLang: 'fr', pennylaneTemplateId: 253634, inboxMatchPattern: 'le filet' },
  { code: 'LVO',  name: "Le Voile d'Ombrage",      email: 'serviceclient@le-voile-ombrage.fr',       defaultLang: 'fr', pennylaneTemplateId: 877143, inboxMatchPattern: 'le voile' },
  { code: 'COCO', name: 'Ma Toile Coco',            email: 'contact@ma-toile-coco.fr',                defaultLang: 'fr', pennylaneTemplateId: 257180, inboxMatchPattern: 'ma toile coco' },
  { code: 'MON',  name: 'Mon Ombrage',              email: 'bonjour@mon-ombrage.fr',                  defaultLang: 'fr', pennylaneTemplateId: 883869, inboxMatchPattern: 'mon ombrage' },
  { code: 'TAR',  name: 'Tarnnetz',                 email: 'Kontakt@tarnnetz.com',                    defaultLang: 'de', pennylaneTemplateId: 257174, inboxMatchPattern: 'tarnnetz' },
  { code: 'HET',  name: 'Het Camouflagenet',        email: 'contact@het-camouflagenet.nl',             defaultLang: 'nl', pennylaneTemplateId: 257162, inboxMatchPattern: 'het' },
  { code: 'RED',  name: 'Red de Camuflaje',         email: 'contacto@red-de-camuflaje.com',            defaultLang: 'es', pennylaneTemplateId: 257168, inboxMatchPattern: 'red' },
  { code: 'RETE', name: 'Rete Mimetica',            email: 'contatto@rete-mimetica.it',                defaultLang: 'it', pennylaneTemplateId: 861190, inboxMatchPattern: 'rete' },
  { code: 'UNI',  name: "L'Univers du Camouflage",  email: 'contact@univers-camouflage.fr',            defaultLang: 'fr', pennylaneTemplateId: 883875, inboxMatchPattern: 'univers' },
];

/**
 * Trouve la config boutique à partir du nom d'inbox FrontApp.
 */
export function getStoreByInboxName(inboxName: string): StoreConfig | undefined {
  const lower = (inboxName || '').toLowerCase();
  return STORES.find((s) => lower.includes(s.inboxMatchPattern));
}

/**
 * Trouve la config boutique par code.
 */
export function getStoreByCode(code: string): StoreConfig | undefined {
  return STORES.find((s) => s.code === code);
}

/**
 * Noms d'inboxes internes à exclure (pas des boutiques).
 */
export const EXCLUDED_INBOX_NAMES = [
  'zephyr o.s.c', 'c bamy', 'factures', 'to keep',
  'bamybox', 'quems box', 'rochman box', 'camouflage net',
];
