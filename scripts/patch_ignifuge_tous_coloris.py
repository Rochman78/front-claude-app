#!/usr/bin/env python3
"""
Ignifugé M3 — tous les coloris (Charles 19/10/2026).

PV Efectis EFR-25-003859 – Révision 1 du 16/10/2026 : « extension de la gamme de coloris »,
coloris = « Tous coloris ». Le sur-mesure ignifugé n'est plus limité au sable et au blanc.

  - prix-ht-sur-mesure.txt (9 boutiques filet) : critère 3 de la vérification
  - FT-Filets-*.pdf (9 boutiques) : n° du PV complété par la révision 1

La règle des instructions se change dans agents/prompt/instructions.md (prompt.py push).

Idempotent. Backup : backups/ignifuge-tous-coloris-<ts>/backup.json
"""
import json
import os
import sys
from datetime import datetime

import psycopg2

REPLACEMENTS = {
    'prix-ht-sur-mesure.txt': [
        (
            '3. IGNIFUGÉ : oui ou non (disponible UNIQUEMENT en couleur sable ou blanc)',
            '3. IGNIFUGÉ : oui ou non (disponible dans toutes les couleurs du catalogue — '
            'PV Efectis EFR-25-003859 Révision 1 du 16/10/2026, « tous coloris »)',
        ),
    ],
    'FT-Filets-': [
        ('EFR-25-003859 — Efectis', 'EFR-25-003859 – Révision 1 du 16/10/2026 (tous coloris) — Efectis'),
    ],
}


def rules_for(name):
    for prefix, rules in REPLACEMENTS.items():
        if name.startswith(prefix):
            return rules
    return None


def main():
    dry = '--dry-run' in sys.argv
    conn = psycopg2.connect(os.environ['DATABASE_URL'])
    cur = conn.cursor()
    cur.execute(
        "SELECT f.id, a.store_code, f.name, f.content FROM agent_files f JOIN agents a ON a.id = f.agent_id "
        "WHERE f.name = 'prix-ht-sur-mesure.txt' OR f.name LIKE 'FT-Filets-%%' ORDER BY f.name, a.store_code"
    )
    backup, ops = [], []
    for file_id, store, name, content in cur.fetchall():
        new = content
        for old, repl in rules_for(name) or []:
            if repl not in new:
                new = new.replace(old, repl)
        if 'UNIQUEMENT en couleur sable ou blanc' in new:
            print(f'⚠️ {store} {name}: restriction sable/blanc restante')
        if new == content:
            continue
        backup.append({'id': file_id, 'store_code': store, 'name': name, 'content': content})
        ops.append((new, file_id))
        print(f'  {store}: {name} ({len(content)} → {len(new)} car.)')

    if not ops:
        print('Déjà à jour')
        return
    if dry:
        print(f'[DRY-RUN] {len(ops)} fichier(s)')
        return

    ts = datetime.now().strftime('%Y%m%d-%H%M%S')
    bdir = os.path.join('backups', f'ignifuge-tous-coloris-{ts}')
    os.makedirs(bdir, exist_ok=True)
    with open(os.path.join(bdir, 'backup.json'), 'w') as f:
        json.dump(backup, f, ensure_ascii=False, indent=1)
    print(f'Backup : {bdir}')
    for params in ops:
        cur.execute('UPDATE agent_files SET content = %s WHERE id = %s', params)
    conn.commit()
    print(f'{len(ops)} fichier(s) mis à jour')


if __name__ == '__main__':
    main()
