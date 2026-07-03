#!/usr/bin/env python3
"""
Patch pour ajouter un bloc « CROQUIS SELON LA FORME — QUOI DEMANDER » juste
AVANT le bloc QUADRILATÈRE QUELCONQUE dans agents.instructions × 10 boutiques.

Motivation : cnv_1lrf14if (LFC, Pierre / Christine Lefebvre, 02/07/2026).
Cliente ayant un triangle 4×4×5 : Claude a demandé « les dimensions de chaque
côté + les angles approximatifs ». Or pour un triangle, 3 côtés suffisent
(SSS → Héron), aucun angle n'est nécessaire. Charles : « on ne demande pas
les angles pour le triangle, juste un croquis vue du dessus ».

Le bloc précise la demande selon la forme :
- Rectangle/carré : 2 dimensions, pas de croquis nécessaire
- Triangle : 3 côtés uniquement (JAMAIS d'angle)
- Trapèze (bases parallèles strictes) : 4 côtés + confirmation parallélisme
- Quadrilatère quelconque : 4 côtés + 1 diagonale (bloc dédié en aval)

Backup pré-patch :
  backups/croquis-triangle-pas-angles-<timestamp>/agents_instructions_backup.json
"""
import os
import sys
import psycopg2
from datetime import datetime

# Marqueur d'insertion : bloc QUADRILATÈRE QUELCONQUE — on insère juste avant.
INSERTION_MARKER = "═══════════════════════════════════════\n⚠️ QUADRILATÈRE QUELCONQUE — FORME ACCEPTÉE"

NEW_BLOCK = """═══════════════════════════════════════
⚠️ CROQUIS SELON LA FORME — CE QU'IL FAUT DEMANDER (ET NE PAS DEMANDER)
═══════════════════════════════════════

Quand tu demandes un croquis au client pour confirmer/préciser la forme d'un filet sur-mesure, ADAPTE ta demande selon la forme. NE JAMAIS demander plus que ce qui est nécessaire au calcul — ça agace le client et fait perdre du temps sur les allers-retours.

RECTANGLE / CARRÉ (2 dimensions) :
  → Pas de croquis nécessaire. Tu redemandes juste la CONFIRMATION des 2 dimensions (longueur × largeur) si nécessaire. Aucun angle, aucune diagonale.

TRIANGLE (3 côtés a, b, c) :
  → Croquis VUE DU DESSUS uniquement pour valider la disposition des 3 côtés cotés (au cas où le client aurait mal ordonné).
  → Tu demandes UNIQUEMENT « les 3 côtés en mètres » ou « la confirmation des 3 côtés déjà donnés ».
  → INTERDIT : demander les angles. Un triangle est ENTIÈREMENT défini par ses 3 côtés (SSS → Héron : surface = √(s(s−a)(s−b)(s−c))). Les angles sont redondants — un client qui a donné 4-4-5 peut légitimement se demander pourquoi on lui redemande des angles.

TRAPÈZE (bases parallèles strictes) :
  → Croquis vue du dessus avec les 4 côtés cotés + confirmation que les 2 bases sont bien parallèles.
  → Pas d'angle, pas de diagonale — un trapèze est défini par ses 4 côtés + le parallélisme.

QUADRILATÈRE QUELCONQUE (4 côtés sans contrainte de parallélisme) :
  → Voir le bloc dédié ci-dessous. Tu demandes 4 côtés + 1 DIAGONALE (d'un coin à son coin opposé). JAMAIS les angles (règle mise à jour 02/07/2026).

FORMULATION TYPE POUR UN TRIANGLE QUAND TU VEUX JUSTE UN CROQUIS DE CONFIRMATION :

Bonjour [Prénom],

Afin de fabriquer votre filet dans les bonnes dimensions et surtout dans le bon sens, nous aurions besoin d'un petit croquis de la zone à couvrir, vue du dessus (comme si vous la regardiez d'en haut).

Pas besoin que ce soit parfait : un simple schéma à main levée suffit largement. L'essentiel est que nous puissions visualiser la disposition des 3 côtés que vous nous avez indiqués ([côtés]).

Vous pouvez tout simplement dessiner la forme sur une feuille, noter les mesures dessus, puis nous envoyer une photo en réponse à ce mail.

Dès réception, nous lancerons la fabrication de votre filet.

Cas réel observé (à NE PAS reproduire) — cnv_1lrf14if (LFC, Christine Lefebvre, 02/07/2026) : cliente ayant un triangle 4×4×5 (donné dès le devis initial + validé + payé). Claude a demandé « les dimensions de chaque côté (en mètres) + les angles approximatifs, si vous le pouvez ». Demande d'angle inutile (3 côtés suffisent pour un triangle) qui laisse la cliente perplexe. La formulation ci-dessus (vue du dessus + confirmation des 3 côtés) est ce qu'il fallait écrire.

═══════════════════════════════════════

"""


def apply_patch(instructions: str) -> tuple[str, bool]:
    if INSERTION_MARKER not in instructions:
        return instructions, False
    # Si le bloc a déjà été inséré, ne pas le refaire
    if "CROQUIS SELON LA FORME — CE QU'IL FAUT DEMANDER" in instructions:
        return instructions, False
    return instructions.replace(INSERTION_MARKER, NEW_BLOCK + INSERTION_MARKER), True


def main():
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        env_path = os.path.join(os.path.dirname(__file__), "..", ".env")
        if os.path.exists(env_path):
            for line in open(env_path):
                if line.startswith("DATABASE_URL="):
                    db_url = line.split("=", 1)[1].strip()
                    break
    if not db_url:
        print("ERROR: DATABASE_URL manquant", file=sys.stderr)
        sys.exit(1)

    conn = psycopg2.connect(db_url)
    cur = conn.cursor()

    cur.execute(
        "SELECT store_code, instructions FROM agents "
        "WHERE store_code IN ('LFC','LVO','COCO','MON','UNI','TAR','HET','RED','REDE','RETE') "
        "ORDER BY store_code"
    )
    rows = cur.fetchall()

    updates = []
    skipped = []
    for store_code, instructions in rows:
        new_instructions, changed = apply_patch(instructions)
        if not changed:
            skipped.append(store_code)
            continue
        updates.append((store_code, new_instructions))

    print(f"À patcher : {len(updates)} ({[u[0] for u in updates]})")
    print(f"Sautées (marqueur absent ou bloc déjà présent) : {len(skipped)} ({skipped})")

    for store_code, new_instructions in updates:
        cur.execute(
            "UPDATE agents SET instructions = %s WHERE store_code = %s",
            (new_instructions, store_code),
        )
        print(f"  ✓ {store_code} : {len(new_instructions)} chars")

    conn.commit()
    cur.close()
    conn.close()
    print(f"\nOK — {len(updates)} boutiques patchées le {datetime.now().isoformat(timespec='seconds')}")


if __name__ == "__main__":
    main()
