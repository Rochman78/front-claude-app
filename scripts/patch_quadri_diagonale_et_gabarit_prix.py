#!/usr/bin/env python3
"""
Deux contradictions entre agent_files et agents.instructions, relevées par le
banc de rejeu du 28/09/2026 (scripts/replay-agents/, run 2026-09-28-13-22).

1. prix-ht-sur-mesure.txt × 9 : le bloc « Quadrilatère quelconque » exigeait
   encore « LES 4 ANGLES AUX SOMMETS — OBLIGATOIRES, pas d'alternative » alors
   que la règle est « 4 côtés + 1 diagonale » depuis le 02/07/2026 (cf. CLAUDE.md).
   Un rejeu a suivi le fichier et demandé les 4 angles au client (cnv_1lnflc5z).
   → bloc réécrit en version diagonale.

2. instructions-devis.txt × 9 : la ligne de gabarit « Filet prix unitaire hors
   TVA : » n'avait AUCUN placeholder → recopiée vide dans 4 brouillons (prix vide
   devant le client, et blocage du garde-fou auto-send). → « X,XX € HT » : si le
   modèle oublie de le remplacer, le garde-fou prix vide d'autoDraftService le
   détecte toujours (pas de chiffre, moins de 4 lettres).

3. (ajout 28/09 après-midi) prix-ht-sur-mesure.txt : la note « ℹ️ QUADRILATÈRE
   QUELCONQUE » répétait « 4 angles obligatoires, diagonale non acceptée ».

Idempotent. Backup : backups/quadri-diagonale-gabarit-prix-<ts>/backup.json
"""
import json
import os
import sys
from datetime import datetime

import psycopg2

OLD_QUADRI = """  • Quadrilatère quelconque (4 côtés + LES 4 ANGLES AUX SOMMETS — OBLIGATOIRES, pas d'alternative) :
        À partir des 4 côtés (a, b, c, d dans l'ordre haut → droite → bas → gauche) et de
        l'angle θ entre les côtés a et b, reconstituer la diagonale par loi des cosinus :
           diag = √(a² + b² − 2·a·b·cos θ)
        Décomposer en 2 triangles : T1 (a, b, diag) et T2 (c, d, diag) → Héron sur chacun.
        surface = Héron(a, b, diag) + Héron(c, d, diag). Arrondir au dixième UNIQUEMENT à la fin.
        ⚠️ Sans les 4 angles, on ne peut PAS calculer la surface — la donnée 4 côtés
           seuls est INSUFFISANTE pour un quadrilatère quelconque. NE JAMAIS conclure « forme
           géométriquement impossible » sur la seule base des 4 côtés ; demander un croquis
           annoté avec LES 4 ANGLES AUX SOMMETS — OBLIGATOIRES."""

NEW_QUADRI = """  • Quadrilatère quelconque (4 côtés + 1 DIAGONALE, d'un coin au coin opposé — JAMAIS les angles) :
        Côtés a, b, c, d dans l'ordre haut → droite → bas → gauche, diagonale « diag »
        mesurée entre le coin a/d et le coin b/c (elle sépare a-b de c-d).
        Décomposer en 2 triangles : T1 (a, b, diag) et T2 (c, d, diag) → Héron sur chacun.
        surface = Héron(a, b, diag) + Héron(c, d, diag). Arrondir au dixième UNIQUEMENT à la fin.
        ⚠️ Sans la diagonale, on ne peut PAS calculer la surface — la donnée 4 côtés
           seuls est INSUFFISANTE pour un quadrilatère quelconque. NE JAMAIS conclure « forme
           géométriquement impossible » sur la seule base des 4 côtés ; demander au client
           les 4 côtés + UNE diagonale (en une seule fois s'il en manque plusieurs).
           NE JAMAIS demander d'angles (règle du 02/07/2026)."""

OLD_NOTE = """ℹ️ QUADRILATÈRE QUELCONQUE = même tarif que Triangle-Trapèze (mêmes lignes,
   mêmes colonnes, mêmes finitions). Le quadrilatère quelconque exige cependant
   un croquis annoté avec LES 4 ANGLES AUX SOMMETS — OBLIGATOIRES (la diagonale
   n'est pas une alternative acceptée) — voir le bloc dédié dans les instructions agent."""

NEW_NOTE = """ℹ️ QUADRILATÈRE QUELCONQUE = même tarif que Triangle-Trapèze (mêmes lignes,
   mêmes colonnes, mêmes finitions). Le quadrilatère quelconque exige cependant
   les 4 côtés + 1 DIAGONALE (jamais les angles) — voir le bloc dédié dans les instructions agent."""

OLD_GABARIT = 'Filet prix unitaire hors TVA :\n'
NEW_GABARIT = 'Filet prix unitaire hors TVA : X,XX € HT\n'


def main():
    dry = '--dry-run' in sys.argv
    conn = psycopg2.connect(os.environ['DATABASE_URL'])
    cur = conn.cursor()
    cur.execute(
        "SELECT f.id, a.store_code, f.name, f.content FROM agent_files f JOIN agents a ON a.id = f.agent_id "
        "WHERE f.name IN ('prix-ht-sur-mesure.txt', 'instructions-devis.txt') ORDER BY a.store_code, f.name"
    )
    backup, ops = [], []
    for file_id, store, name, content in cur.fetchall():
        pairs = [(OLD_QUADRI, NEW_QUADRI), (OLD_NOTE, NEW_NOTE)] if name == 'prix-ht-sur-mesure.txt' else [(OLD_GABARIT, NEW_GABARIT)]
        new = content
        for old, new_txt in pairs:
            if new_txt in new:
                continue
            if new.count(old) != 1:
                print(f'  ⚠️ {store} {name} : bloc introuvable ou multiple ({new.count(old)}) → skip')
                continue
            new = new.replace(old, new_txt)
        if new == content:
            print(f'  {store} {name} : déjà à jour')
            continue
        backup.append({'id': file_id, 'store_code': store, 'name': name, 'content': content})
        ops.append((new, file_id))
        print(f'  {store} {name} : patch')
    if not ops or dry:
        print(f'{"[DRY-RUN] " if dry else ""}{len(ops)} fichier(s) à modifier')
        return
    ts = datetime.now().strftime('%Y%m%d-%H%M%S')
    bdir = os.path.join('backups', f'quadri-diagonale-gabarit-prix-{ts}')
    os.makedirs(bdir, exist_ok=True)
    with open(os.path.join(bdir, 'backup.json'), 'w') as f:
        json.dump(backup, f, ensure_ascii=False, indent=1)
    for content, file_id in ops:
        cur.execute('UPDATE agent_files SET content = %s WHERE id = %s', (content, file_id))
    conn.commit()
    print(f'Backup : {bdir}\n{len(ops)} fichier(s) modifié(s)')


if __name__ == '__main__':
    main()
