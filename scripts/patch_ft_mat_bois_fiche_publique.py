#!/usr/bin/env python3
"""
Fiche technique mât en bois — alignement sur la fiche publique FT_Mat_Bois_LFC.pdf
(Charles 13/10/2026).

Boutiques qui vendent le mât en bois (LFC, COCO, LVO, MON) : FT-Mat-Bois-Robinier.txt
existe déjà et reste la référence interne (SKU, scellement, transport, France uniquement).
La fiche publique apporte 3 informations absentes :
  - poids 13,5 à 14 kg (la fiche disait « Poids selon lot »)
  - compatibilité / utilisation (filets de camouflage + toiles d'ombrage en fibre de coco)
  - réserve « bois naturel : forme, diamètre et veinage varient d'un mât à l'autre »

Les 6 autres boutiques ne vendent pas ce mât : rien n'y est ajouté.

Idempotent. Backup : backups/ft-mat-bois-fiche-publique-<ts>/backup.json
"""
import json
import os
import sys
from datetime import datetime

import psycopg2

SELLERS = {'LFC', 'COCO', 'LVO', 'MON'}
FT_NAME = 'FT-Mat-Bois-Robinier.txt'

POIDS_OLD = '- Poids selon lot (bois massif — livraison palette)'
POIDS_NEW = '- Poids : 13,5 à 14 kg (bois massif — livraison palette)'

VARIATION_MARKER = 'peuvent légèrement varier d\'un mât à l\'autre'
VARIATION_ANCHOR = '- Rectitude contrôlée sur toute la hauteur\n'
VARIATION_LINE = (
    '- Bois naturel : la forme, le diamètre et le veinage peuvent légèrement varier d\'un mât à l\'autre\n'
    '  (spécifications indicatives, variables selon les lots).\n'
)

USAGE_MARKER = 'COMPATIBILITÉ & UTILISATION'
USAGE_ANCHOR = 'CHARGE & RÉSISTANCE\n'
USAGE_BLOCK = (
    'COMPATIBILITÉ & UTILISATION\n'
    '- Compatible : filets de camouflage et toiles d\'ombrage en fibre de coco.\n'
    '- Usage : point d\'ancrage pour l\'installation d\'un filet ou d\'une toile d\'ombrage\n'
    '  (jardin, terrasse, événementiel).\n'
    '- Contenu : 1 mât de 300 cm + 1 piton à œil inox monté en tête.\n'
    '\n'
)


def patch(content):
    new = content.replace(POIDS_OLD, POIDS_NEW)
    if VARIATION_MARKER not in new and VARIATION_ANCHOR in new:
        new = new.replace(VARIATION_ANCHOR, VARIATION_ANCHOR + VARIATION_LINE, 1)
    if USAGE_MARKER not in new and USAGE_ANCHOR in new:
        new = new.replace(USAGE_ANCHOR, USAGE_BLOCK + USAGE_ANCHOR, 1)
    return new


def main():
    dry = '--dry-run' in sys.argv
    conn = psycopg2.connect(os.environ['DATABASE_URL'])
    cur = conn.cursor()
    cur.execute(
        'SELECT f.id, a.store_code, f.content FROM agent_files f JOIN agents a ON a.id = f.agent_id '
        'WHERE f.name = %s ORDER BY a.store_code', (FT_NAME,)
    )
    rows = cur.fetchall()

    missing = SELLERS - {store for _, store, _ in rows}
    if missing:
        print(f'⚠️ {FT_NAME} absent chez : {", ".join(sorted(missing))}')

    backup = []
    ops = []
    for file_id, store, content in rows:
        if store not in SELLERS:
            print(f'  {store}: ne vend pas le mât en bois — ignoré')
            continue
        new = patch(content)
        if new == content:
            continue
        if '13,5 à 14 kg' not in new or VARIATION_MARKER not in new or USAGE_MARKER not in new:
            print(f'⚠️ {store}: ancre introuvable, fiche non modifiée')
            continue
        backup.append({'id': file_id, 'store_code': store, 'name': FT_NAME, 'content': content})
        ops.append((new, file_id, store))
        print(f'  {store}: fiche technique {len(content)} → {len(new)} car.')

    if not ops:
        print('Déjà à jour')
        return
    if dry:
        print(f'[DRY-RUN] {len(ops)} opération(s)')
        return

    ts = datetime.now().strftime('%Y%m%d-%H%M%S')
    bdir = os.path.join('backups', f'ft-mat-bois-fiche-publique-{ts}')
    os.makedirs(bdir, exist_ok=True)
    with open(os.path.join(bdir, 'backup.json'), 'w') as f:
        json.dump(backup, f, ensure_ascii=False, indent=1)
    print(f'Backup : {bdir}')
    for new, file_id, _ in ops:
        cur.execute('UPDATE agent_files SET content = %s WHERE id = %s', (new, file_id))
    conn.commit()
    print(f'{len(ops)} opération(s) appliquée(s)')


if __name__ == '__main__':
    main()
