#!/usr/bin/env python3
"""
Mât en bois — vocabulaire client « bois massif naturel » (Charles 13/10/2026).

La fiche publique ne cite ni l'essence (Robinier) ni le fournisseur (SPARS design) :
les agents ne doivent plus les écrire à un client. Sur LFC, COCO, LVO, MON :
  - FT-Mat-Bois-Robinier.txt renommé FT-Mat-Bois.txt
  - essence et fournisseur retirés de la fiche, règle de vocabulaire ajoutée en tête

La ligne des instructions se change dans agents/prompt/instructions.md (prompt.py push).

Idempotent. Backup : backups/mat-bois-naturel-<ts>/backup.json
"""
import json
import os
import re
import sys
from datetime import datetime

import psycopg2

SELLERS = {'LFC', 'COCO', 'LVO', 'MON'}
OLD_NAME = 'FT-Mat-Bois-Robinier.txt'
NEW_NAME = 'FT-Mat-Bois.txt'

REPLACEMENTS = [
    ('FICHE TECHNIQUE — MÂT EN BOIS ROBINIER (', 'FICHE TECHNIQUE — MÂT EN BOIS NATUREL ('),
    (
        'Fournisseur : SPARS design\n',
        'VOCABULAIRE CLIENT : « mât en bois naturel », « bois massif naturel ». Ne jamais citer\n'
        'l\'essence du bois ni le fournisseur. Si le client demande l\'essence → 🟠 en QUESTIONS\n'
        'au gérant, rien dans le brouillon.\n',
    ),
    ('- Essence : Robinier (Robinia pseudoacacia)\n', '- Matière : bois massif naturel\n'),
    ('- Mât en bois Robinier (SKU 3770043027001)', '- Mât en bois naturel (SKU 3770043027001)'),
]
FORBIDDEN_RE = re.compile(r'robinier|robinia|spars', re.I)


def main():
    dry = '--dry-run' in sys.argv
    conn = psycopg2.connect(os.environ['DATABASE_URL'])
    cur = conn.cursor()
    cur.execute(
        'SELECT f.id, a.store_code, f.name, f.content FROM agent_files f JOIN agents a ON a.id = f.agent_id '
        'WHERE f.name IN (%s, %s) ORDER BY a.store_code', (OLD_NAME, NEW_NAME)
    )
    rows = cur.fetchall()

    backup = []
    ops = []
    for file_id, store, name, content in rows:
        if store not in SELLERS:
            print(f'  {store}: ne vend pas le mât en bois — ignoré')
            continue
        new = content
        for old, repl in REPLACEMENTS:
            new = new.replace(old, repl)
        if FORBIDDEN_RE.search(new):
            print(f'⚠️ {store}: mention essence / fournisseur restante, fiche non modifiée')
            continue
        if new == content and name == NEW_NAME:
            continue
        backup.append({'id': file_id, 'store_code': store, 'name': name, 'content': content})
        ops.append((NEW_NAME, new, file_id))
        print(f'  {store}: {name} → {NEW_NAME} ({len(content)} → {len(new)} car.)')

    if not ops:
        print('Déjà à jour')
        return
    if dry:
        print(f'[DRY-RUN] {len(ops)} opération(s)')
        return

    ts = datetime.now().strftime('%Y%m%d-%H%M%S')
    bdir = os.path.join('backups', f'mat-bois-naturel-{ts}')
    os.makedirs(bdir, exist_ok=True)
    with open(os.path.join(bdir, 'backup.json'), 'w') as f:
        json.dump(backup, f, ensure_ascii=False, indent=1)
    print(f'Backup : {bdir}')
    for params in ops:
        cur.execute('UPDATE agent_files SET name = %s, content = %s WHERE id = %s', params)
    conn.commit()
    print(f'{len(ops)} opération(s) appliquée(s)')


if __name__ == '__main__':
    main()
