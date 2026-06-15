#!/usr/bin/env python3
"""V2 : insère les 8 nouveaux SKU câble acier après la DERNIÈRE ligne câble
acier connue du fichier, peu importe le nom de la section.

Robuste à la diversité des nommages de sections selon les boutiques
(« FILETS CABLE ACIER », « TARNNETZ AVEC CÂBLE ACIER », « Red de
camuflaje de cable de acero », etc.).
"""
import os
import sys
import psycopg2

DATABASE_URL = os.environ.get("DATABASE_URL", "")
VAT_RATES = [0, 17, 18, 19, 20, 21, 22, 23, 24, 25, 25.5, 27]

NEW_LINES = [
    ("Militaire", "4x5", "3760388679324", 249.90),
    ("Noir",      "4x5", "3760388679317", 249.90),
    ("Bleu",      "3x4", "3760388679300", 152.90),
    ("Bleu",      "4x5", "3760388679294", 249.90),
    ("Gris",      "3x4", "3760388679362", 152.90),
    ("Gris",      "4x5", "3760388679355", 249.90),
    ("Vert",      "3x4", "3760388679348", 152.90),
    ("Vert",      "4x5", "3760388679331", 249.90),
]

# SKU câble acier existants déjà dans les fichiers (filets, pas accessoires)
KNOWN_CABLE_SKUS = {
    "3760388670123", "3760388679157", "3760388679140", "3760388679133",
    "3760388678440", "3760388679126", "3760388670130", "3760388679119",
    "3760388679102", "3760388679096", "3760388678433", "3760388679195",
    "3760388670109", "3760388670116",
}


def format_line(color: str, size: str, sku: str, ttc: float) -> str:
    col_color = color.ljust(36)
    col_size = " " + size.ljust(10) + " "
    col_sku = " " + sku + "  "
    col_ttc = f"{ttc:.2f}".rjust(8) + " "
    hts = [round(ttc / (1 + r / 100), 2) for r in VAT_RATES]
    middle = "|".join(f"{h:.2f}".rjust(7) + " " for h in hts[:-1])
    last = f"{hts[-1]:.2f}".rjust(7)
    return f"{col_color}|{col_size}|{col_sku}|{col_ttc}|{middle}|{last}"


def insert_new_skus(content: str) -> tuple[str, int]:
    # Idempotence : si un des 8 nouveaux SKU est déjà présent → skip
    for _, _, sku, _ in NEW_LINES:
        if sku in content:
            return content, 0

    lines = content.split("\n")
    last_cable_idx = -1
    for i, line in enumerate(lines):
        parts = line.split("|")
        if len(parts) == 16:
            sku = parts[2].strip()
            if sku in KNOWN_CABLE_SKUS:
                last_cable_idx = i

    if last_cable_idx < 0:
        # Pas de câble acier dans ce fichier (COCO) → on ne touche pas
        return content, 0

    new_lines_to_insert = [format_line(c, s, sku, ttc) for c, s, sku, ttc in NEW_LINES]
    out = lines[: last_cable_idx + 1] + new_lines_to_insert + lines[last_cable_idx + 1 :]
    return "\n".join(out), len(new_lines_to_insert)


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "dry"
    if mode not in ("dry", "apply"):
        print("Usage: python3 add_cable_acier_v2.py [dry|apply]")
        sys.exit(1)

    with psycopg2.connect(DATABASE_URL) as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT af.id, a.store_code, af.content "
            "FROM agent_files af JOIN agents a ON a.id = af.agent_id "
            "WHERE af.name = 'prix-ht-standards.txt' "
            "ORDER BY a.store_code"
        )
        rows = cur.fetchall()
        updates = []
        for fid, code, content in rows:
            new_content, n = insert_new_skus(content)
            if n == 0:
                print(f"  {code}: pas de modification (déjà à jour ou pas de câble acier)")
                continue
            print(f"  {code}: +{n} lignes ({len(content)} → {len(new_content)} chars)")
            updates.append((fid, code, new_content))

        if mode == "dry":
            print("\n🔍 Dry-run terminé.")
            return

        for fid, code, new_content in updates:
            cur.execute("UPDATE agent_files SET content = %s WHERE id = %s", (new_content, fid))
            print(f"  ✓ {code}")
        conn.commit()
        print(f"\n✅ {len(updates)} fichiers mis à jour.")


if __name__ == "__main__":
    main()
