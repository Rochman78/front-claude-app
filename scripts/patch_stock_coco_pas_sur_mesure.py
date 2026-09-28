#!/usr/bin/env python3
"""
Stock partiel / rupture sur coco et accessoires → JAMAIS de sur-mesure.

Cas déclencheur 28/09/2026 — cnv_1mcdaown (COCO, toile coco triangle
naturel 3×3×3, 1 en stock sur 2) : le brouillon a proposé « pour la seconde
unité, nous pourrions la fabriquer sur mesure aux mêmes dimensions, délai
21 jours ». Le coco n'existe PAS en sur-mesure. Cause principale corrigée
côté code (PR #232, blocs STOCK injectés par /api/plugin/analyze) ; ce
patch aligne les instructions agents.

Changements :
1. × 10 agents — ÉTAPE 2 VÉRIFICATION STOCK : les puces RUPTURE et STOCK
   PARTIEL reçoivent l'exception coco / accessoires / échantillons.
2. COCO uniquement — bloc prioritaire « COCO — AUCUN SUR-MESURE » inséré
   juste après la RÈGLE MÉTA (avant le bloc LANGUE).

Idempotent : relancer = 0 changement.
Backup pré-patch : backups/stock-coco-pas-sur-mesure-<ts>/agents_instructions_backup.json
"""
import json
import os
import sys
from datetime import datetime

import psycopg2

SEP = '═══════════════════════════════════════'

# --- 1. Puces ÉTAPE 2 (× 10) ---
OLD_RUPTURE = (
    '• Bloc « 🚨 RUPTURE STOCK » présent → NE JAMAIS chiffrer au tarif catalogue. '
    'Suis la procédure rupture standard (proposer sur-mesure aux mêmes dimensions '
    'OU inscription notification réassort sur la fiche produit du site).'
)
NEW_RUPTURE = (
    '• Bloc « 🚨 RUPTURE STOCK » présent → NE JAMAIS chiffrer au tarif catalogue. '
    'Suis la procédure rupture standard (proposer sur-mesure aux mêmes dimensions '
    'OU inscription notification réassort sur la fiche produit du site). '
    'EXCEPTION : fibre de coco (toiles, rideaux), accessoires et échantillons '
    'n\'existent PAS en sur-mesure → UNIQUEMENT la notification réassort sur la '
    'fiche produit du site, jamais de sur-mesure ni de délai 21 jours.'
)
OLD_PARTIEL = (
    '• Bloc « ⚠️ STOCK PARTIEL » présent → chiffrer au catalogue MAIS mentionner '
    'explicitement la qté immédiatement disponible et la qté restante en '
    'sur-mesure (formulation type fournie dans le bloc).'
)
NEW_PARTIEL = (
    '• Bloc « ⚠️ STOCK PARTIEL » présent → chiffrer au catalogue MAIS mentionner '
    'explicitement la qté immédiatement disponible et la qté restante en '
    'sur-mesure (formulation type fournie dans le bloc). EXCEPTION : fibre de '
    'coco (toiles, rideaux), accessoires et échantillons → le solde n\'est JAMAIS '
    'proposé en sur-mesure : on indique la qté disponible et on renvoie vers la '
    'notification réassort sur la fiche produit du site.'
)

# --- 2. Bloc prioritaire COCO ---
COCO_ANCHOR = SEP + '\n⚠️ LANGUE — TOUT EN FRANÇAIS DANS LE PLUGIN'
COCO_MARKER = '⚠️ COCO — AUCUN SUR-MESURE, JAMAIS'
COCO_BLOCK = (
    SEP + '\n'
    + COCO_MARKER + '\n'
    + SEP + '\n\n'
    'Ma Toile Coco ne vend QUE des produits standard catalogue (toiles coco, rideaux '
    'coco, accessoires). AUCUN produit n\'est fabriqué sur mesure — ni en coco, ni '
    'en polyester, ni en câble acier.\n\n'
    'INTERDIT dans tout brouillon : « fabriquer sur mesure », « aux mêmes dimensions », '
    '« délai d\'environ 21 jours », prix au m², grille sur-mesure. Les blocs du '
    'présent prompt qui parlent de sur-mesure / filets / tranches de surface ne '
    's\'appliquent PAS à cette boutique.\n\n'
    'Rupture ou stock partiel → indiquer la quantité disponible (si > 0) et renvoyer '
    'vers la notification réassort sur la fiche produit du site (bouton pour saisir '
    'son e-mail). Taille hors catalogue → refuser poliment et lister les tailles '
    'standard disponibles.\n\n'
    'Cas réel (à NE PAS reproduire) — cnv_1mcdaown (28/09/2026) : 2 toiles coco '
    'triangle naturel 3×3×3 demandées, 1 en stock → le brouillon a proposé de '
    '« fabriquer la seconde sur mesure aux mêmes dimensions (21 jours) ». Faux.\n\n'
)


def main():
    dry = '--dry-run' in sys.argv
    conn = psycopg2.connect(os.environ['DATABASE_URL'])
    cur = conn.cursor()
    cur.execute('SELECT id, store_code, instructions FROM agents ORDER BY store_code')
    agents = cur.fetchall()

    if not dry:
        ts = datetime.now().strftime('%Y%m%d-%H%M%S')
        bdir = os.path.join('backups', f'stock-coco-pas-sur-mesure-{ts}')
        os.makedirs(bdir, exist_ok=True)
        with open(os.path.join(bdir, 'agents_instructions_backup.json'), 'w') as f:
            json.dump([{'id': a[0], 'store_code': a[1], 'instructions': a[2]} for a in agents],
                      f, ensure_ascii=False, indent=1)
        print(f'Backup : {bdir}')

    changed = 0
    for agent_id, store, text in agents:
        new = text
        notes = []
        for old, repl, label in ((OLD_RUPTURE, NEW_RUPTURE, 'rupture'), (OLD_PARTIEL, NEW_PARTIEL, 'partiel')):
            if repl in new:
                continue
            if new.count(old) != 1:
                print(f'  ⚠️ {store}: puce {label} introuvable ou multiple ({new.count(old)}) → skip')
                continue
            new = new.replace(old, repl)
            notes.append(label)
        if store == 'COCO' and COCO_MARKER not in new:
            if new.count(COCO_ANCHOR) != 1:
                print(f'  ⚠️ COCO: ancre LANGUE introuvable → bloc non inséré')
            else:
                new = new.replace(COCO_ANCHOR, COCO_BLOCK + COCO_ANCHOR)
                notes.append('bloc COCO')
        if new != text:
            changed += 1
            print(f'  {store}: {", ".join(notes)} ({len(text)} → {len(new)} car.)')
            if not dry:
                cur.execute('UPDATE agents SET instructions = %s WHERE id = %s', (new, agent_id))
        else:
            print(f'  {store}: déjà à jour')

    if not dry:
        conn.commit()
    print(f'{"[DRY-RUN] " if dry else ""}{changed} agent(s) modifié(s)')


if __name__ == '__main__':
    main()
