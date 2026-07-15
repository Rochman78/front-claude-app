#!/usr/bin/env python3
"""
add_rideau_coco.py — Ajout de la gamme "rideau coco" au catalogue × 10 boutiques.

Charles 15/07/2026 : la gamme rideau coco existe côté Shopify avec 6 SKUs
(2×2, 2×3, 2×4, 2×5, 2×6, 2×7), mais dans le catalogue BDD :
- 2 SKUs sont mal classés en "voile coco" (3760388679218 / 3760388679201)
- 4 SKUs manquent totalement (3760388679461, 3760388679454, 3760388679447, 3760388679430)

Ce script :
  1. Reclassifie les 2 SKUs existants : typologie voile coco → rideau coco
     (on garde la forme carré/rectangle actuelle et les prix HT recalculés)
  2. Insère les 4 nouveaux SKUs avec HT recalculés par TVA
  3. Backup + apply/dry mode
"""
import os
import sys
import psycopg2
from datetime import datetime

DATABASE_URL = os.environ.get("DATABASE_URL", "")

VAT_RATES = [0, 17, 18, 19, 20, 21, 22, 23, 24, 25, 25.5, 27]

# Widths mesurées sur les lignes existantes (COCO catalogue)
W_TYPO, W_FORME, W_MATIERE, W_COULEUR, W_TAILLE, W_SKU = 12, 20, 14, 14, 12, 16
W_TTC = 9
W_HT = 9        # colonnes 7-16 (0% à 25%)
W_HT_255 = 10   # colonne 17 (25.5%) — 1 char plus large
W_HT_LAST = 8   # colonne 18 (27%) — pas de trailing space

# 2 SKUs existants à reclassifier (typologie + forme si besoin) — les prix restent identiques
# Format: SKU: (nouvelle_typologie, nouvelle_forme, taille pour rappel)
RECLASSIFY = {
    "3760388679218": ("rideau coco", "rectangle", "2x2"),
    "3760388679201": ("rideau coco", "rectangle", "2x4"),
}

# 4 nouveaux SKUs à insérer (typologie, forme, matiere, couleur, taille, sku, TTC)
NEW_LINES = [
    ("rideau coco", "rectangle", "coco", "naturel", "2x3", "3760388679461", 144.90),
    ("rideau coco", "rectangle", "coco", "naturel", "2x5", "3760388679454", 235.90),
    ("rideau coco", "rectangle", "coco", "naturel", "2x6", "3760388679447", 280.90),
    ("rideau coco", "rectangle", "coco", "naturel", "2x7", "3760388679430", 326.90),
]


def pad_left(val: str, width: int) -> str:
    """Champ aligné à gauche : ' <val>' + padding jusqu'à width."""
    return (" " + val).ljust(width)


def pad_left_first(val: str, width: int) -> str:
    """Première colonne : '<val>' + padding (pas de leading space)."""
    return val.ljust(width)


def build_line(typo, forme, matiere, couleur, taille, sku, ttc) -> str:
    """Construit une ligne au format catalogue standard (19 colonnes)."""
    parts = [
        pad_left_first(typo, W_TYPO),
        pad_left(forme, W_FORME),
        pad_left(matiere, W_MATIERE),
        pad_left(couleur, W_COULEUR),
        pad_left(taille, W_TAILLE),
        pad_left(sku, W_SKU),
        f"{ttc:.2f}".rjust(W_TTC - 1) + " ",
    ]
    hts = [round(ttc / (1 + r / 100), 2) for r in VAT_RATES]
    # HT 0% à 24% (10 colonnes) : width 9 chars each
    for i, h in enumerate(hts[:10]):
        parts.append(f"{h:.2f}".rjust(W_HT - 1) + " ")
    # HT 25% : width 9
    # HT 25.5% : width 10
    parts.append(f"{hts[10]:.2f}".rjust(W_HT_255 - 1) + " ")
    # HT 27% : width 8 (no trailing space)
    parts.append(f"{hts[11]:.2f}".rjust(W_HT_LAST))
    return "|".join(parts)


def reclassify_line(line: str) -> tuple[str, bool]:
    """Si la ligne correspond à un SKU à reclassifier, retourne (new_line, True)."""
    parts = line.split("|")
    if len(parts) != 19:
        return line, False
    sku = parts[5].strip()
    if sku not in RECLASSIFY:
        return line, False
    new_typo, new_forme, _ = RECLASSIFY[sku]
    parts[0] = pad_left_first(new_typo, W_TYPO)
    parts[1] = pad_left(new_forme, W_FORME)
    return "|".join(parts), True


def process_content(content: str) -> tuple[str, int]:
    """Reclassifie les lignes existantes + insère les nouvelles à la suite du dernier voile coco/rideau coco."""
    lines = content.split("\n")
    changed = 0

    # Étape 1 : reclassifier
    for i, line in enumerate(lines):
        new_line, was_changed = reclassify_line(line)
        if was_changed:
            lines[i] = new_line
            changed += 1

    # Étape 2 : insérer les 4 nouvelles lignes juste après la dernière ligne
    # "rideau coco" (post-reclassification) — pour garder les blocs groupés.
    # Skip si déjà présent (idempotence).
    existing_skus = set()
    last_rideau_idx = -1
    for i, line in enumerate(lines):
        parts = line.split("|")
        if len(parts) == 19:
            sku = parts[5].strip()
            typo = parts[0].strip()
            existing_skus.add(sku)
            if typo == "rideau coco":
                last_rideau_idx = i

    # Insertion
    to_insert = [
        build_line(*t) for t in NEW_LINES
        if t[5] not in existing_skus
    ]
    if to_insert and last_rideau_idx >= 0:
        lines[last_rideau_idx + 1: last_rideau_idx + 1] = to_insert
        changed += len(to_insert)

    return "\n".join(lines), changed


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "dry"
    if mode not in ("dry", "apply"):
        print("Usage: python3 add_rideau_coco.py [dry|apply]")
        sys.exit(1)

    if not DATABASE_URL:
        print("DATABASE_URL non défini")
        sys.exit(1)

    with psycopg2.connect(DATABASE_URL) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT af.id, a.store_code, af.content "
                "FROM agent_files af JOIN agents a ON a.id = af.agent_id "
                "WHERE af.name = 'prix-ht-standards.txt' "
                "ORDER BY a.store_code"
            )
            rows = cur.fetchall()
            print(f"📁 {len(rows)} fichiers prix-ht-standards.txt en BDD.\n")

            if mode == "apply":
                stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
                bak_dir = f"/Users/charlesbamy/front-claude-app/backups/rideau-coco-{stamp}"
                os.makedirs(bak_dir, exist_ok=True)
                print(f"📦 Backup dans {bak_dir}\n")

            for file_id, code, content in rows:
                new_content, changed = process_content(content)
                if changed == 0:
                    print(f"  {code}: rien à changer (déjà à jour ?)")
                    continue
                print(f"  {code}: {changed} ligne(s) changée(s)")

                if mode == "apply":
                    with open(os.path.join(bak_dir, f"{code}.txt"), "w") as f:
                        f.write(content)
                    cur.execute(
                        "UPDATE agent_files SET content = %s WHERE id = %s",
                        (new_content, file_id)
                    )

            if mode == "apply":
                conn.commit()
                print("\n✅ Commit BDD OK.")
            else:
                print("\n(mode dry — aucun changement en BDD)")


if __name__ == "__main__":
    main()
