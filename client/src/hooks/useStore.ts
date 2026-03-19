import type { FrontSingleConversationContext } from '../providers/FrontContext';

/** Mapping email d'inbox → code boutique */
const EMAIL_MAPPING: Record<string, string> = {
  'serviceclient@le-filet-de-camouflage.fr': 'LFC',
  'serviceclient@le-voile-ombrage.fr': 'LVO',
  'contact@ma-toile-coco.fr': 'COCO',
  'bonjour@mon-ombrage.fr': 'MON',
  'kontakt@tarnnetz.com': 'TAR',
  'contact@het-camouflagenet.nl': 'HET',
  'contacto@red-de-camuflaje.com': 'RED',
  'contatto@rete-mimetica.it': 'RETE',
  'contact@univers-camouflage.fr': 'UNI',
};

/** Mapping pattern dans le nom d'inbox → code boutique (fallback) */
const NAME_PATTERNS: [string, string][] = [
  ['le filet', 'LFC'],
  ['le voile', 'LVO'],
  ['ma toile coco', 'COCO'],
  ['mon ombrage', 'MON'],
  ['tarnnetz', 'TAR'],
  ['het', 'HET'],
  ['red', 'RED'],
  ['rete', 'RETE'],
  ['univers', 'UNI'],
];

export interface StoreInfo {
  code: string;
  inboxId: string;
  inboxName: string;
}

/**
 * Détecte la boutique à partir du contexte Front App.
 * Priorité : email inbox → pattern dans le nom inbox.
 */
export function detectStore(context: FrontSingleConversationContext): StoreInfo | null {
  const inboxes = context.conversation.inboxes;
  if (!inboxes || inboxes.length === 0) return null;

  for (const inbox of inboxes) {
    // Essayer par email d'abord
    const address = (inbox.address || '').toLowerCase();
    if (address && EMAIL_MAPPING[address]) {
      return { code: EMAIL_MAPPING[address], inboxId: inbox.id, inboxName: inbox.name };
    }

    // Fallback par nom d'inbox
    const name = (inbox.name || '').toLowerCase();
    for (const [pattern, code] of NAME_PATTERNS) {
      if (name.includes(pattern)) {
        return { code, inboxId: inbox.id, inboxName: inbox.name };
      }
    }
  }

  return null;
}
