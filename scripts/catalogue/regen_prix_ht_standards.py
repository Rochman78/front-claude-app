#!/usr/bin/env python3
"""Regénère prix-ht-standards.txt × 10 agents à partir du CSV LFC.

Règle :
- TTC = price_eur du CSV (TVA FR 20% par défaut LFC) — IDENTIQUE pour les 10 boutiques
- HT_X% = TTC / (1 + X/100) arrondi à 2 décimales
- 12 taux TVA : 0% (LIC/export = TTC), 17%, 18%, 19%, 20%, 21%, 22%, 23%, 24%, 25%, 25,5%, 27%

Mode 'dry' : affiche le diff sans toucher la BDD.
Mode 'apply' : update agent_files.

Comportement par ligne :
- Si SKU absent du CSV → ligne intacte (Charles : "remplacer juste les prix aux bons endroits en fonction du SKU")
- Si SKU présent → recalcul TTC + 12 HT, alignement colonnes préservé à l'identique
- Lignes sans SKU 13 chiffres (titres section, séparateurs, commentaires) → intactes
"""
import csv
import os
import sys
import psycopg2

CSV_PATH = "/Users/charlesbamy/Desktop/LFC_catalogue.csv"
DATABASE_URL = os.environ.get("DATABASE_URL", "")

VAT_RATES = [0, 17, 18, 19, 20, 21, 22, 23, 24, 25, 25.5, 27]


def load_csv() -> dict:
    """SKU → TTC (float)."""
    out: dict[str, float] = {}
    with open(CSV_PATH) as f:
        for r in csv.DictReader(f):
            sku = (r.get("sku") or "").strip()
            price = (r.get("price_eur") or "").strip()
            if sku and price:
                try:
                    out[sku] = float(price.replace(",", "."))
                except ValueError:
                    pass
    return out


def reformat_line(line: str, sku_to_ttc: dict) -> tuple[str, bool]:
    """Réécrit une ligne data si son SKU est dans le CSV. Renvoie (nouvelle_ligne, changé)."""
    parts = line.split("|")
    if len(parts) != 16:
        return line, False
    sku = parts[2].strip()
    if not sku.isdigit() or len(sku) < 12:
        return line, False
    if sku not in sku_to_ttc:
        return line, False

    new_ttc = sku_to_ttc[sku]
    hts = [round(new_ttc / (1 + r / 100), 2) for r in VAT_RATES]

    # Largeurs constatées : col 3 TTC = 9 chars (" XXX.XX "), col 4-14 HT = 8 chars,
    # col 15 HT 27% = 7 chars (pas de trailing space — fin de ligne).
    new_parts = parts[:3]
    new_parts.append(f"{new_ttc:.2f}".rjust(8) + " ")
    for h in hts[:-1]:
        new_parts.append(f"{h:.2f}".rjust(7) + " ")
    new_parts.append(f"{hts[-1]:.2f}".rjust(7))

    new_line = "|".join(new_parts)
    return new_line, new_line != line


def process_content(content: str, sku_to_ttc: dict) -> tuple[str, int, int]:
    """Renvoie (nouveau_content, nb_lignes_modifiées, nb_SKU_du_CSV_trouvés)."""
    new_lines = []
    changed = 0
    found_skus = set()
    for line in content.split("\n"):
        # Ne pas toucher au newline final
        new_line, was_changed = reformat_line(line, sku_to_ttc)
        if was_changed:
            changed += 1
            parts = line.split("|")
            if len(parts) == 16:
                found_skus.add(parts[2].strip())
        new_lines.append(new_line)
    return "\n".join(new_lines), changed, len(found_skus)


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "dry"
    if mode not in ("dry", "apply"):
        print("Usage: python3 regen_prix_ht.py [dry|apply]")
        sys.exit(1)

    sku_to_ttc = load_csv()
    print(f"📋 CSV chargé : {len(sku_to_ttc)} SKU avec prix TTC.\n")

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

            updates = []
            for file_id, code, content in rows:
                new_content, changed, found = process_content(content, sku_to_ttc)
                if new_content == content:
                    print(f"  {code}: aucun changement (peut-être un format ≠)")
                    continue
                pct = 100 * found / len(sku_to_ttc) if sku_to_ttc else 0
                print(f"  {code}: {changed} ligne(s) modifiée(s), {found}/{len(sku_to_ttc)} SKU CSV trouvés ({pct:.0f}%)")
                updates.append((file_id, code, new_content))

            if mode == "dry":
                print("\n🔍 Dry-run : aucun update en BDD.")
                # Sample diff sur LFC
                lfc = next((r for r in rows if r[1] == "LFC"), None)
                if lfc:
                    fid, code, content = lfc
                    new_content, _, _ = process_content(content, sku_to_ttc)
                    old_lines = content.split("\n")
                    new_lines = new_content.split("\n")
                    print("\n=== Échantillon LFC (5 premières lignes modifiées) ===")
                    n = 0
                    for o, nv in zip(old_lines, new_lines):
                        if o != nv:
                            print(f"  - {o}")
                            print(f"  + {nv}")
                            n += 1
                            if n >= 5:
                                break
                return

            # Apply
            print(f"\n→ Update de {len(updates)} fichiers…")
            for fid, code, new_content in updates:
                cur.execute("UPDATE agent_files SET content = %s WHERE id = %s", (new_content, fid))
                print(f"  ✓ {code}")
            conn.commit()
            print(f"\n✅ {len(updates)} fichiers mis à jour.")


if __name__ == "__main__":
    main()
