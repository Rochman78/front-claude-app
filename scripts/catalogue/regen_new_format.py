#!/usr/bin/env python3
"""Réécrit prix-ht-standards.txt × 10 stores en format tabulaire plat.

Format de chaque ligne :
  typologie | forme | matiere | couleur | taille | SKU | TTC | HT 0% | HT 17% | HT 18% | HT 19% | HT 20% | HT 21% | HT 22% | HT 23% | HT 24% | HT 25% | HT 25,5% | HT 27%

Métadonnées produit lues depuis scripts/catalogue/sku_metadata.csv (validées
par Charles). Prix TTC + HT lus depuis le fichier actuel de CHAQUE STORE
(pour préserver les éventuels écarts de prix inter-store). Un SKU présent
dans le fichier actuel mais absent du CSV metadata → conservé mais marqué
NEEDS_REVIEW (pour audit).

Backup automatique dans backups/new-format-standards-<timestamp>/ AVANT
toute modif BDD (déjà pris par le shell).
"""
import csv
import os
import re
import sys
import psycopg2

DATABASE_URL = os.environ["DATABASE_URL"]

# Colonnes finales du fichier
COLS = ["typologie", "forme", "matiere", "couleur", "taille", "SKU",
        "TTC", "HT 0%", "HT 17%", "HT 18%", "HT 19%", "HT 20%",
        "HT 21%", "HT 22%", "HT 23%", "HT 24%", "HT 25%", "HT 25,5%", "HT 27%"]

# Largeurs de colonnes (visuelles, séparateur = " | ")
WIDTHS = [11, 18, 12, 12, 10, 14, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 8, 7]

HEADER_BLOCK = """═══════════════════════════════════════════════════════════════════════════════
PRIX STANDARDS CATALOGUE — FORMAT TABULAIRE STRICT
═══════════════════════════════════════════════════════════════════════════════

Chaque ligne DÉCRIT UN PRODUIT UNIQUE via 6 CRITÈRES puis SON PRIX.

COLONNES (dans l'ordre) :
  1. typologie   : filet | voile coco | accessoire | echantillon
  2. forme       : rectangle | carré | triangle | corde | cable | rislan | mât télescopique | base ancrage | kit de fixation | corde à cliquets | borne solaire
  3. matiere     : polyester | câble acier | coco | acier | n/a
  4. couleur     : sable | blanc | vert | militaire | noir | gris | bleu | naturel | n/a
  5. taille      : dimensions (ex : 3x4, 5x5x5, 7,5m, 1 pièce)
  6. SKU         : identifiant unique 13 chiffres
  7. TTC         : prix TTC en euros
  8-19. HT XX%   : prix HT selon taux TVA du pays de livraison (0 %, 17 %, ..., 27 %)

⚠️ RÈGLE ABSOLUE DE MATCHING (4 CRITÈRES STRICTS) :
Pour qu'un produit soit qualifié STANDARD, les 4 critères ci-dessous doivent
correspondre PARFAITEMENT à UNE ligne :
  (a) TYPOLOGIE du produit
  (b) FORME (rectangle/carré/triangle ne sont PAS interchangeables — un
      client qui demande un « carré 3x3 » n'accepte pas un « rectangle 3x3 »
      même si la surface est identique, ce sont des SKU différents)
  (c) MATIÈRE (polyester ≠ câble acier ≠ coco ; NE JAMAIS matcher sur une
      ligne polyester quand le client demande câble acier — cas cnv_1lrhc3br)
  (d) COULEUR (sable ≠ blanc ≠ vert etc.)
  (e) TAILLE (exacte ou inversée si rectangle : 3x4 = 4x3, mais 3x4 ≠ 3x5)

Si UN SEUL des critères ne matche pas → SUR-MESURE (via prix-ht-sur-mesure.txt)
ou refus si combinaison impossible (ex : triangle câble acier = SUR-MESURE
uniquement, aucun standard triangle acier n'existe).

⚠️ LECTURE DU PRIX HT selon pays de livraison client :
  France FR 20 %       → colonne HT 20%
  Allemagne DE 19 %    → colonne HT 19%
  Pays-Bas NL 21 %     → colonne HT 21%
  Belgique BE 21 %     → colonne HT 21%
  Espagne ES 21 %      → colonne HT 21%
  Portugal PT 23 %     → colonne HT 23%
  Italie IT 22 %       → colonne HT 22%
  Luxembourg LU 17 %   → colonne HT 17%
  Autriche AT 20 %     → colonne HT 20%
  Royaume-Uni GB 20 %  → colonne HT 20%
  Hors UE / export     → colonne HT 0% (TTC)
  B2B intra UE avec TVA valide hors pays boutique → colonne HT 0%

═══════════════════════════════════════════════════════════════════════════════

"""

# TVA à 12 taux dans le fichier actuel : 0, 17, 18, 19, 20, 21, 22, 23, 24, 25, 25.5, 27
VAT_RATES = [0, 17, 18, 19, 20, 21, 22, 23, 24, 25, 25.5, 27]


def load_metadata() -> dict:
    """SKU → {typologie, forme, matiere, couleur, taille, ttc_ref_lfc}."""
    out = {}
    with open("scripts/catalogue/sku_metadata.csv") as f:
        for row in csv.DictReader(f):
            out[row["sku"].strip()] = row
    return out


def extract_prices(content: str) -> dict:
    """Extrait SKU → (ttc, [HT × 12]) depuis le fichier actuel d'un store."""
    out = {}
    for line in content.split("\n"):
        parts = line.split("|")
        if len(parts) != 16:
            continue
        sku = parts[2].strip()
        if not re.match(r"^\d{12,14}$", sku):
            continue
        try:
            ttc = float(parts[3].strip().replace(",", "."))
        except ValueError:
            continue
        hts = []
        for p in parts[4:]:
            try:
                hts.append(float(p.strip().replace(",", ".")))
            except ValueError:
                break
        if len(hts) != 12:
            continue
        out[sku] = (ttc, hts)
    return out


def fmt_price(v: float) -> str:
    """Format monétaire uniforme : 149.90 → '149.90', 6.90 → '  6.90'."""
    return f"{v:.2f}"


def render_row(cells: list[str]) -> str:
    """Renvoie 'a | b | c' avec largeurs fixes pour visuel."""
    out = []
    for i, c in enumerate(cells):
        w = WIDTHS[i]
        if i < 6:  # colonnes texte à gauche
            out.append(str(c)[:w].ljust(w))
        else:      # colonnes prix à droite
            out.append(str(c).rjust(w))
    return " | ".join(out)


def build_content(store_code: str, meta: dict, prices: dict, missing_meta_skus: list) -> str:
    """Génère le contenu complet du nouveau fichier pour un store."""
    lines = [HEADER_BLOCK]

    # En-tête tabulaire
    header_row = render_row(COLS)
    sep_row = "-" * len(header_row)
    lines.append(header_row)
    lines.append(sep_row)

    # Trier les SKU par (typologie, matière, forme, couleur, taille) pour lecture facile
    def sort_key(sku):
        m = meta.get(sku, {})
        return (
            m.get("typologie", "z"),
            m.get("matiere", "z"),
            m.get("forme", "z"),
            m.get("couleur", "z"),
            m.get("taille", "z"),
            sku,
        )

    sorted_skus = sorted(prices.keys(), key=sort_key)
    prev_group = None
    for sku in sorted_skus:
        m = meta.get(sku)
        ttc, hts = prices[sku]
        if not m:
            # SKU dans le fichier actuel mais pas dans le CSV metadata
            missing_meta_skus.append(sku)
            row = ["???", "???", "???", "???", "???", sku, fmt_price(ttc)]
        else:
            row = [
                m["typologie"],
                m["forme"],
                m["matiere"],
                m["couleur"],
                m["taille"],
                sku,
                fmt_price(ttc),
            ]
        row += [fmt_price(h) for h in hts]
        # Insérer une ligne vide entre 2 groupes typologie/matière/forme
        group = (m.get("typologie") if m else "?", m.get("matiere") if m else "?",
                 m.get("forme") if m else "?")
        if prev_group and prev_group != group:
            lines.append("")
        prev_group = group
        lines.append(render_row(row))

    return "\n".join(lines) + "\n"


def main():
    if not os.path.exists("scripts/catalogue/sku_metadata.csv"):
        print("ERROR: scripts/catalogue/sku_metadata.csv absent", file=sys.stderr)
        sys.exit(1)

    meta = load_metadata()
    print(f"Métadonnées : {len(meta)} SKU")

    total_missing = 0
    with psycopg2.connect(DATABASE_URL) as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT af.id, a.store_code, af.content "
            "FROM agent_files af JOIN agents a ON a.id=af.agent_id "
            "WHERE af.name='prix-ht-standards.txt' ORDER BY a.store_code"
        )
        rows = cur.fetchall()
        updates = []
        for fid, code, old in rows:
            prices = extract_prices(old)
            missing = []
            new_content = build_content(code, meta, prices, missing)
            print(f"  {code}: {len(prices)} SKU, {len(missing)} sans metadata, "
                  f"{len(old)} → {len(new_content)} chars ({(len(new_content)-len(old))*100/len(old):+.0f}%)")
            if missing:
                print(f"    MANQUENT : {', '.join(missing[:8])}"
                      f"{'...' if len(missing)>8 else ''}")
                total_missing += len(missing)
            updates.append((fid, code, new_content, len(prices), len(missing)))

        # Sauvegarder la V2 dans /tmp pour review humaine AVANT le commit BDD
        os.makedirs("/tmp/new_format_preview", exist_ok=True)
        for _, code, content, _, _ in updates:
            with open(f"/tmp/new_format_preview/{code}.txt", "w") as f:
                f.write(content)
        print(f"\n📁 Preview écrit dans /tmp/new_format_preview/")

        if "--apply" in sys.argv:
            for fid, code, content, _, _ in updates:
                cur.execute("UPDATE agent_files SET content=%s WHERE id=%s", (content, fid))
            conn.commit()
            print(f"\n✓ {len(updates)} fichiers écrits en BDD.")
        else:
            print(f"\n[DRY RUN] Pass --apply pour committer en BDD.")


if __name__ == "__main__":
    main()
