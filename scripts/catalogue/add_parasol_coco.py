#!/usr/bin/env python3
"""
add_parasol_coco.py — Ajout du parasol coco et de son socle au catalogue COCO.

Charles 29/09/2026 : ces 2 produits sont vendus UNIQUEMENT sur Ma Toile Coco
(MTC) et n'avaient jamais été dans prix-ht-standards.txt (le pipeline des prix
part du catalogue LFC, qui ne les vend pas). Cas déclencheur cnv_1mdiad5j
(Agora PNC Boulazac, 10 parasols + 10 socles) : l'agent n'avait aucun prix.

  Parasol en fibre de coco    3760388679379   699,99 € TTC
  Socle pour parasol coco     3760388679386    49,90 € TTC

Seule la boutique COCO est modifiée. Idempotent (SKU déjà présent = rien à faire).
Usage : python3 scripts/catalogue/add_parasol_coco.py [dry|apply]
"""
import os
import sys
from datetime import datetime

import psycopg2

sys.path.insert(0, os.path.dirname(__file__))
from add_rideau_coco import build_line  # même format de ligne (19 colonnes)

DATABASE_URL = os.environ.get("DATABASE_URL", "")
STORE = "COCO"

# (ligne après laquelle insérer : typologie, forme) → lignes à insérer
# Le socle rejoint les accessoires, le parasol forme son propre bloc à la suite.
SOCLE = ("accessoire", "socle parasol", "n/a", "n/a", "1 pièce", "3760388679386", 49.90)
PARASOL = ("parasol coco", "parasol", "coco", "naturel", "1 pièce", "3760388679379", 699.99)


def process_content(content: str) -> tuple[str, int]:
    lines = content.split("\n")
    skus = {l.split("|")[5].strip() for l in lines if len(l.split("|")) == 19}
    added = 0

    if SOCLE[5] not in skus:
        last_acc = max(i for i, l in enumerate(lines) if l.startswith("accessoire "))
        lines.insert(last_acc + 1, build_line(*SOCLE))
        added += 1

    if PARASOL[5] not in skus:
        last_acc = max(i for i, l in enumerate(lines) if l.startswith("accessoire "))
        lines[last_acc + 1:last_acc + 1] = ["", build_line(*PARASOL)]
        added += 1

    return "\n".join(lines), added


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "dry"
    if mode not in ("dry", "apply"):
        sys.exit("usage: add_parasol_coco.py [dry|apply]")
    if not DATABASE_URL:
        sys.exit("DATABASE_URL manquant")

    with psycopg2.connect(DATABASE_URL) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT af.id, af.content FROM agent_files af JOIN agents a ON a.id = af.agent_id "
                "WHERE af.name = 'prix-ht-standards.txt' AND a.store_code = %s",
                (STORE,),
            )
            row = cur.fetchone()
            if not row:
                sys.exit(f"prix-ht-standards.txt introuvable pour {STORE}")
            file_id, content = row

            new_content, added = process_content(content)
            if added == 0:
                print(f"{STORE}: rien à changer (déjà à jour)")
                return
            for l in new_content.split("\n"):
                if "3760388679379" in l or "3760388679386" in l:
                    print(f"  + {l[:110]}")

            if mode == "apply":
                stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
                bak_dir = os.path.join(os.path.dirname(__file__), "..", "..", "backups", f"parasol-coco-{stamp}")
                os.makedirs(bak_dir, exist_ok=True)
                with open(os.path.join(bak_dir, f"{STORE}.txt"), "w") as f:
                    f.write(content)
                cur.execute("UPDATE agent_files SET content = %s WHERE id = %s", (new_content, file_id))
                conn.commit()
                print(f"✅ {STORE}: {added} ligne(s) ajoutée(s), backup {os.path.normpath(bak_dir)}")
            else:
                print(f"(dry) {STORE}: {added} ligne(s) à ajouter")


if __name__ == "__main__":
    main()
