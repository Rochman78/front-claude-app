#!/usr/bin/env python3
"""
COCO uniquement — suppression des blocs « filet sur-mesure » hérités des
agents filet (Ma Toile Coco ne vend aucun sur-mesure, cf. cnv_1mcdaown
28/09/2026 et scripts/patch_stock_coco_pas_sur_mesure.py).

Blocs supprimés (validés par Charles 28/09/2026) :
  1. ⚠️ CROQUIS SELON LA FORME
  2. ⚠️ QUADRILATÈRE QUELCONQUE
  3. ⚠️ TAILLE FILET — SUR-MESURE D'ABORD
  4. ⚠️ TRANCHE SUR-MESURE
  5. PÉRIMÈTRE DU SUR-MESURE (sous-bloc des RÈGLES PRIORITAIRES)
Blocs mixtes conservés : CLASSIFICATION STANDARD vs SUR-MESURE (porte le
refus coco hors catalogue), LECTURE DES CROQUIS.

Idempotent. Backup : backups/coco-purge-sur-mesure-<ts>/agents_instructions_backup.json
"""
import json
import os
import sys
from datetime import datetime

import psycopg2

SEP = '═══════════════════════════════════════'

# (label, début inclus, fin exclue)
CUTS = [
    ('CROQUIS SELON LA FORME + QUADRILATÈRE QUELCONQUE',
     SEP + '\n⚠️ CROQUIS SELON LA FORME',
     SEP + '\n⚠️ TVA — RÈGLE PAR DÉFAUT'),
    ('TAILLE FILET + TRANCHE SUR-MESURE',
     SEP + '\n⚠️ TAILLE FILET — AUCUN CONSEIL',
     SEP + '\n⚠️ ACCESSOIRES — PRIX STRICT'),
    ('PÉRIMÈTRE DU SUR-MESURE',
     'PÉRIMÈTRE DU SUR-MESURE — LIMITATION STRICTE :\n',
     '2. WORKFLOW : Tu proposes TOUJOURS'),
]


def main():
    dry = '--dry-run' in sys.argv
    conn = psycopg2.connect(os.environ['DATABASE_URL'])
    cur = conn.cursor()
    cur.execute("SELECT id, instructions FROM agents WHERE store_code = 'COCO'")
    agent_id, text = cur.fetchone()

    new = text
    for label, start, end in CUTS:
        if new.count(start) != 1:
            print(f'  {label} : déjà supprimé (ou ancre ambiguë : {new.count(start)})')
            continue
        i = new.index(start)
        j = new.find(end, i)
        if j < 0:
            print(f'  ⚠️ {label} : fin introuvable → skip')
            continue
        print(f'  {label} : -{j - i} car.')
        new = new[:i] + new[j:]

    if new == text:
        print('COCO déjà à jour')
        return
    print(f'COCO : {len(text)} → {len(new)} car.')
    if dry:
        print('[DRY-RUN] rien écrit')
        return
    ts = datetime.now().strftime('%Y%m%d-%H%M%S')
    bdir = os.path.join('backups', f'coco-purge-sur-mesure-{ts}')
    os.makedirs(bdir, exist_ok=True)
    with open(os.path.join(bdir, 'agents_instructions_backup.json'), 'w') as f:
        json.dump([{'id': agent_id, 'store_code': 'COCO', 'instructions': text}], f, ensure_ascii=False, indent=1)
    print(f'Backup : {bdir}')
    cur.execute('UPDATE agents SET instructions = %s WHERE id = %s', (new, agent_id))
    conn.commit()


if __name__ == '__main__':
    main()
