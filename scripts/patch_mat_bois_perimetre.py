#!/usr/bin/env python3
"""
Mât en bois Robinier (SKU 3770043027001) — périmètre de vente (Charles 28/09/2026) :
vendu UNIQUEMENT sur LFC, COCO, LVO, MON, et UNIQUEMENT pour une livraison en France.

Avant ce patch, les 10 agents avaient la ligne catalogue (249,99 €) + la fiche
technique FT-Mat-Bois-Robinier.txt → HET/RED/REDE/RETE/TAR/UNI pouvaient le proposer.

1. Boutiques qui NE le vendent PAS (HET, RED, REDE, RETE, TAR, UNI) :
   - retrait de la ligne SKU 3770043027001 de prix-ht-standards.txt
     (regen_prix_ht_standards.py ne ré-ajoute jamais une ligne absente)
   - suppression de l'agent_file FT-Mat-Bois-Robinier.txt
   - retrait de la ligne « Mât en bois Robinier … SKU 3770043027001 » des instructions
2. Boutiques qui le vendent (LFC, COCO, LVO, MON) :
   - règle « livraison en France uniquement » ajoutée sous la ligne SKU des instructions
     et dans la fiche technique
   - fiche technique : prix résiduel 219,99 € corrigé en 249,99 € (catalogue = autorité)

Idempotent. Backup : backups/mat-bois-perimetre-<ts>/ (instructions + fichiers touchés).
"""
import json
import os
import re
import sys
from datetime import datetime

import psycopg2

SKU = '3770043027001'
SELLERS = {'LFC', 'COCO', 'LVO', 'MON'}
FT_NAME = 'FT-Mat-Bois-Robinier.txt'

INSTR_LINE_RE = re.compile(r'^([ \t]*)- Mât en bois Robinier \(SPARS design\) \.\.\.\. SKU ' + SKU + r'[^\n]*\n', re.M)
FRANCE_MARKER = 'Mât en bois : livraison en FRANCE uniquement'
FRANCE_RULE = (
    '⚠️ Mât en bois : livraison en FRANCE uniquement (transport C Chez vous). '
    'Adresse de livraison hors de France → ne pas le proposer ni le chiffrer : '
    'indiquer qu\'il n\'est pas disponible pour ce pays et proposer le mât '
    'télescopique aluminium (SKU 3760263850060) si pertinent.'
)
FT_FRANCE = (
    '\nZONE DE LIVRAISON\n'
    '- Livraison en FRANCE uniquement. Aucune expédition hors de France '
    '(proposer le mât télescopique aluminium à la place).\n'
)


def main():
    dry = '--dry-run' in sys.argv
    conn = psycopg2.connect(os.environ['DATABASE_URL'])
    cur = conn.cursor()
    cur.execute('SELECT id, store_code, instructions FROM agents ORDER BY store_code')
    agents = cur.fetchall()
    cur.execute(
        "SELECT f.id, a.store_code, f.name, f.content FROM agent_files f JOIN agents a ON a.id = f.agent_id "
        "WHERE f.name IN (%s, 'prix-ht-standards.txt')", (FT_NAME,)
    )
    files = cur.fetchall()

    backup = {'agents': [], 'agent_files': []}
    ops = []  # (sql, params, label)

    for agent_id, store, text in agents:
        new = text
        m = INSTR_LINE_RE.search(new)
        if store in SELLERS:
            if m and FRANCE_MARKER not in new:
                indent = m.group(1)
                new = new[:m.end()] + f'{indent}  {FRANCE_RULE}\n' + new[m.end():]
        elif m:
            new = INSTR_LINE_RE.sub('', new, count=1)
        if new != text:
            backup['agents'].append({'id': agent_id, 'store_code': store, 'instructions': text})
            ops.append(('UPDATE agents SET instructions = %s WHERE id = %s', (new, agent_id), f'{store}: instructions'))

    for file_id, store, name, content in files:
        row = {'id': file_id, 'store_code': store, 'name': name, 'content': content}
        if name == 'prix-ht-standards.txt':
            if store in SELLERS:
                continue
            lines = content.split('\n')
            kept = [l for l in lines if f'| {SKU} ' not in l and f'|{SKU}|' not in l.replace(' ', '')]
            if len(kept) != len(lines):
                backup['agent_files'].append(row)
                ops.append(('UPDATE agent_files SET content = %s WHERE id = %s', ('\n'.join(kept), file_id),
                            f'{store}: prix-ht-standards −{len(lines) - len(kept)} ligne'))
        elif name == FT_NAME:
            if store in SELLERS:
                new = content.replace(': 219,99 € TTC', ': 249,99 € TTC')
                if 'ZONE DE LIVRAISON' not in new:
                    new = new.rstrip('\n') + '\n' + FT_FRANCE
                if new != content:
                    backup['agent_files'].append(row)
                    ops.append(('UPDATE agent_files SET content = %s WHERE id = %s', (new, file_id), f'{store}: fiche technique'))
            else:
                backup['agent_files'].append(row)
                ops.append(('DELETE FROM agent_files WHERE id = %s', (file_id,), f'{store}: suppression {FT_NAME}'))

    for _, _, label in ops:
        print(f'  {label}')
    if not ops:
        print('Déjà à jour')
        return
    if dry:
        print(f'[DRY-RUN] {len(ops)} opération(s)')
        return

    ts = datetime.now().strftime('%Y%m%d-%H%M%S')
    bdir = os.path.join('backups', f'mat-bois-perimetre-{ts}')
    os.makedirs(bdir, exist_ok=True)
    with open(os.path.join(bdir, 'backup.json'), 'w') as f:
        json.dump(backup, f, ensure_ascii=False, indent=1)
    print(f'Backup : {bdir}')
    for sql, params, _ in ops:
        cur.execute(sql, params)
    conn.commit()
    print(f'{len(ops)} opération(s) appliquée(s)')


if __name__ == '__main__':
    main()
