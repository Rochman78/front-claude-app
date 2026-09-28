#!/usr/bin/env python3
"""
Liste les divergences d'instructions entre les agents boutiques (LECTURE SEULE).

Les divergences sont souvent VOULUES (gamme vendue différente : ex. pas de mât
en bois sur HET, COCO sans sur-mesure). Ce script ne corrige rien : il produit
un rapport à faire classer « voulue » / « patch raté » par Charles.

Méthode : chaque ligne d'instructions est normalisée (code boutique, préfixe de
commande, nom boutique remplacés par des jetons), puis on liste les lignes qui
ne sont pas présentes chez TOUTES les boutiques comparées, regroupées par bloc
(dernier titre ⚠️ rencontré).

Usage : python3 scripts/agents-audit/diff_agents.py [--with-coco] > rapport.md
"""
import os
import re
import sys
from collections import defaultdict

import psycopg2

def normalize(line, store, store_name):
    s = line.strip()
    if store_name:
        s = re.sub(re.escape(store_name), '<BOUTIQUE>', s, flags=re.I)
    # code boutique masqué uniquement dans les lignes « CETTE boutique (XXX) » (sinon
    # les cas réels qui citent « (LFC, …) » deviennent de faux écarts)
    s = re.sub(r'(boutique|Préfixe boutique) \(' + re.escape(store) + r'\)', r'\1 (<CODE>)', s)
    s = re.sub(r'#?[A-Z]{1,5}\d{5}\b', '<CMD>', s)
    s = re.sub(r'#?[A-Z]{1,5}x{5}\b', '<CMDx>', s)
    return s


def main():
    with_coco = '--with-coco' in sys.argv
    conn = psycopg2.connect(os.environ['DATABASE_URL'])
    cur = conn.cursor()
    cur.execute('SELECT store_code, name, instructions FROM agents ORDER BY store_code')
    agents = [a for a in cur.fetchall() if with_coco or a[0] != 'COCO']
    stores = [a[0] for a in agents]

    presence = defaultdict(set)      # ligne normalisée -> boutiques
    block_of = {}                    # ligne normalisée -> titre de bloc (1re occurrence)
    order = {}
    for store, name, text in agents:
        block = '(début)'
        for i, raw in enumerate((text or '').split('\n')):
            if raw.startswith('⚠️') or raw.startswith('🚨'):
                block = raw.strip()[:100]
            n = normalize(raw, store, None)
            if not n or set(n) <= set('═─-•'):
                continue
            presence[n].add(store)
            block_of.setdefault(n, block)
            order.setdefault(n, (block, i))

    diverging = [l for l, s in presence.items() if len(s) < len(stores)]
    by_block = defaultdict(list)
    for l in diverging:
        by_block[block_of[l]].append(l)

    print(f'# Divergences entre agents ({", ".join(stores)})\n')
    print(f'{len(diverging)} lignes présentes dans certaines boutiques seulement, sur {len(presence)} lignes distinctes.\n')
    print('À classer pour chaque ligne : **voulue** (gamme, langue, préfixe…) ou **patch raté**.\n')
    for block in sorted(by_block, key=lambda b: min(order[l] for l in by_block[b])[1]):
        print(f'\n## {block}\n')
        for l in sorted(by_block[block], key=lambda x: order[x][1]):
            have = sorted(presence[l])
            missing = [s for s in stores if s not in presence[l]]
            who = f'seulement {",".join(have)}' if len(have) <= len(stores) / 2 else f'absente chez {",".join(missing)}'
            print(f'- [{who}] {l[:220]}')


if __name__ == '__main__':
    main()
