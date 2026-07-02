#!/usr/bin/env python3
"""
Patch le bloc QUADRILATÈRE QUELCONQUE dans agents.instructions × 10 boutiques.
Remplace la règle "4 angles aux sommets obligatoires" (posée le 18/06/2026)
par "4 côtés + 1 diagonale" (démarche + fiable au mètre ruban, 2026-07-02).

Backup pré-patch : backups/quadrilatere-diagonale-<timestamp>/agents_instructions_backup.json
"""
import os
import re
import sys
import json
import psycopg2
from datetime import datetime

# ── Nouvelle version du bloc ────────────────────────────────────────────────
NEW_BLOCK = """═══════════════════════════════════════
⚠️ QUADRILATÈRE QUELCONQUE — FORME ACCEPTÉE, MAIS EXIGE UN CROQUIS ANNOTÉ
═══════════════════════════════════════

L'atelier sait fabriquer 4 catégories de filets sur-mesure : RECTANGLE/CARRÉ, TRIANGLE, TRAPÈZE (bases parallèles strictes), QUADRILATÈRE QUELCONQUE (4 côtés sans contrainte de parallélisme). Pour le quadrilatère quelconque, le tarif sur-mesure est IDENTIQUE à celui du Triangle-Trapèze (mêmes lignes / colonnes / finitions dans `prix-ht-sur-mesure.txt`).

⚠️ INTERDICTION ABSOLUE — VERDICT « GÉOMÉTRIQUEMENT IMPOSSIBLE » SUR LA SEULE BASE DES 4 CÔTÉS :

Si le client donne 4 côtés et que tu n'arrives pas à reconstituer un trapèze classique (bases parallèles), NE JAMAIS écrire au client :
- « ces mesures ne forment pas un trapèze géométriquement réalisable »
- « le côté X est trop court pour relier les autres »
- « il y a une incohérence géométrique dans vos dimensions »
- toute formulation qui sous-entend que la forme demandée n'existe pas

Ces formulations sont FAUSSES dans 99 % des cas : un quadrilatère avec 4 côtés respectant l'inégalité quadrilatérale (chaque côté < somme des 3 autres) existe TOUJOURS sous forme de quadrilatère quelconque. Le problème n'est pas la forme — c'est qu'il MANQUE une donnée pour fixer la forme et calculer la surface.

POURQUOI 4 CÔTÉS SEULS NE SUFFISENT PAS :

Contrairement au triangle (3 côtés → forme UNIQUE et surface calculable par Héron), un quadrilatère à 4 côtés n'est PAS rigide : il peut prendre une infinité de formes (comme un parallélogramme articulé qui s'ouvre ou s'aplatit) et donc une infinité de surfaces. Il faut UNE donnée géométrique supplémentaire qui « fige » la forme.

CE QUE TU DOIS DEMANDER AU CLIENT — 4 CÔTÉS + 1 DIAGONALE — OBLIGATOIRES :

UN CROQUIS À MAIN LEVÉE avec :
  • les 4 côtés cotés dans l'ordre haut → droite → bas → gauche
  • UNE diagonale (d'un coin à son coin opposé) : le client tend le mètre d'un angle à l'angle diamétralement opposé et note la longueur

Une diagonale est trivial à mesurer au mètre ruban (une simple longueur), là où les angles au rapporteur sont peu fiables sur le terrain — une petite erreur d'angle se propage énormément sur la surface. Sans la diagonale, ne JAMAIS chiffrer.

CALCUL DE SURFACE — APRÈS RÉCEPTION DU CROQUIS AVEC LA DIAGONALE :

La diagonale divise le quadrilatère en 2 triangles dont TOUS les côtés sont connus. Appliquer Héron sur chacun :
  • Triangle 1 = (côté haut, côté droite, diagonale) → surface S1 = Héron(a, b, diag)
  • Triangle 2 = (côté bas, côté gauche, diagonale) → surface S2 = Héron(c, d, diag)
  • Surface totale = S1 + S2

Rappel formule de Héron pour un triangle de côtés x, y, z :
  s = (x + y + z) / 2 (demi-périmètre)
  Surface = √(s · (s−x) · (s−y) · (s−z))

Arrondir UNIQUEMENT le résultat final au dixième de m² (les valeurs intermédiaires restent en pleine précision).

⚠️ Toujours annoncer en QUESTIONS S1, S2 et la surface totale AVANT d'écrire un prix dans le brouillon.

FORMULATION TYPE DU BROUILLON QUAND IL MANQUE LA DONNÉE :

Bonjour [Prénom],

Merci pour ces précisions. Pour un quadrilatère, les 4 côtés seuls ne nous permettent pas de calculer précisément la surface : votre forme n'est pas rigide, elle peut s'ouvrir ou s'aplatir, et la surface (donc le prix) varie selon la géométrie réelle.

Pouvez-vous nous transmettre un petit croquis à main levée de votre zone avec :
  • les 4 côtés cotés dans l'ordre (haut, droite, bas, gauche)
  • la longueur d'UNE diagonale (d'un coin à son coin opposé — vous tendez le mètre en travers, d'un angle à l'angle en face)

Cette diagonale nous permet de découper votre zone en 2 triangles et donc de calculer à la fois la surface exacte et le plan de découpe du filet.

Dès réception, nous vous transmettons le chiffrage complet.

QUESTIONS GÉRANT (toujours inclure) :
1. ⚠️ Le client demande un quadrilatère quelconque (côtés : …). Il manque UNE diagonale pour fixer la forme et calculer la surface. J'ai demandé un croquis annoté avec les 4 côtés + 1 diagonale. Peux-tu valider ?

CAS RÉEL OBSERVÉ — NE PAS REPRODUIRE :

cnv_1lnflc5z (LFC, Dominique Delpit, 18/06/2026) : client demande un filet « type trapèze » avec côtés haut 4,4 m / droite 3 m / bas 5,32 m / gauche 1 m. Sous hypothèse trapèze (bases parallèles), ces mesures sont effectivement géométriquement incompatibles. MAIS en tant que quadrilatère quelconque, ces 4 côtés respectent l'inégalité quadrilatérale (5,32 < 4,4 + 3 + 1 = 8,4) et définissent une forme FABRICABLE dès qu'on connaît une diagonale. Claude a répondu au client « ces mesures ne forment pas un trapèze géométriquement réalisable », ce qui est CORRECT au sens strict du trapèze mais TROMPEUR pour le client. Le bon brouillon était de demander les 4 côtés + 1 diagonale, sans verdict d'impossibilité.

Note évolution : règle mise à jour le 02/07/2026 — auparavant on demandait les 4 ANGLES aux sommets. Les angles sont sur-déterminés (2 opposés suffiraient via Bretschneider) et peu fiables au rapporteur sur le terrain ; UNE diagonale suffit géométriquement (2 triangles via Héron), se mesure trivialement au mètre ruban, et donne en plus la forme réelle pour la découpe."""


# ── Bounds de l'ancien bloc ────────────────────────────────────────────────
# Début : ligne "═══" suivie de "⚠️ QUADRILATÈRE QUELCONQUE — ..."
# Fin   : dernière phrase du bloc, "...sans verdict d'impossibilité."
BLOCK_START = re.compile(
    r"═{5,}\s*\n⚠️\s*QUADRILATÈRE\s+QUELCONQUE\s*—",
    re.UNICODE,
)
# On matche jusqu'à la fin de la phrase du cas Dominique Delpit
BLOCK_END_PATTERN = "sans verdict d'impossibilité."


def replace_block(instructions: str) -> tuple[str, bool]:
    """Retourne (new_instructions, replaced). replaced=False si le bloc n'a pas
    été trouvé (rien changé)."""
    m = BLOCK_START.search(instructions)
    if not m:
        return instructions, False
    start = m.start()
    # Cherche la fin
    end_pos = instructions.find(BLOCK_END_PATTERN, start)
    if end_pos < 0:
        return instructions, False
    end = end_pos + len(BLOCK_END_PATTERN)
    # Le nouveau bloc remplace la portion [start, end)
    return instructions[:start] + NEW_BLOCK + instructions[end:], True


def main():
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        # Fallback : lire depuis .env
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
        new_instructions, replaced = replace_block(instructions)
        if not replaced:
            # COCO n'a pas de sur-mesure → probablement pas de bloc quadrilatère
            skipped.append(store_code)
            continue
        updates.append((store_code, new_instructions))

    print(f"À mettre à jour : {len(updates)} boutiques ({[u[0] for u in updates]})")
    print(f"Sautées (bloc absent) : {len(skipped)} ({skipped})")

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
