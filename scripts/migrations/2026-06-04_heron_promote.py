#!/usr/bin/env python3
"""
Fix prix-ht-sur-mesure.txt sur les 8 boutiques sur-mesure :
1. Supprime la phrase trompeuse "Calcul surface : Rectangle=L×l | Triangle=(b×h)/2..."
   qui induit Claude à appliquer (base×côté)/2 et à confondre côté isocèle avec hauteur.
2. Supprime la duplication du bloc règles d'arrondi (présent 2 fois).
3. Promeut la règle Héron en TÊTE du fichier (juste après le titre), avec un
   exemple chiffré explicite 6×4,3×4,3 → 9,2 m² (PAS 12,9).
"""
import re, subprocess
from pathlib import Path

DATABASE_URL = subprocess.check_output(
    "grep DATABASE_URL /Users/charlesbamy/front-claude-app/.env | cut -d= -f2-",
    shell=True
).decode().strip()

STORES = ["LFC", "LVO", "MON", "UNI", "TAR", "HET", "RED", "RETE"]  # 8 stores sur-mesure (COCO exclu)

HERON_HEADER = """⚠️ CALCUL DE SURFACE — RÈGLE FONDAMENTALE (à appliquer AVANT toute lecture de prix)

Le formulaire client fournit toujours des CÔTÉS, jamais une hauteur.
  • Rectangle (2 dimensions : L × l) → surface = L × l
  • Triangle  (3 CÔTÉS, ex « 6x4,3x4,3 » ou « 5x4x4 ») → OBLIGATOIRE : FORMULE DE HÉRON
        s = (a + b + c) / 2
        surface = √( s × (s−a) × (s−b) × (s−c) )
  • Trapèze   (4 dimensions : B, b, h, côté latéral) → ((B + b) × h) / 2

⚠️ INTERDIT pour un triangle : appliquer (base × côté)/2 en prenant un côté du triangle
   à la place de la HAUTEUR. Ces deux valeurs sont DIFFÉRENTES. Toujours utiliser Héron
   quand le client donne 3 côtés.

EXEMPLE CHIFFRÉ (à reproduire mentalement avant chaque devis triangle) :
   Triangle isocèle 6 × 4,3 × 4,3 m  (1 base + 2 côtés égaux)
     s = (6 + 4,3 + 4,3) / 2 = 7,3
     surface = √(7,3 × 1,3 × 3 × 3) = √85,41 = 9,24 m² → arrondi au dixième : 9,2 m²
   ❌ ERREUR FRÉQUENTE : faire (6 × 4,3) / 2 = 12,9 m² (faux — 4,3 n'est PAS la hauteur).
      Ici, la hauteur réelle vaut √(4,3² − 3²) ≈ 3,08 m, et (6 × 3,08)/2 ≈ 9,24 m² ✓.

ARRONDI DIMENSIONS : toutes les dimensions sont au DIXIÈME de mètre (1 décimale max),
   quelle que soit la source. Ex : 4,25 m → 4,2 m. Si le client a demandé plus fin,
   l'indiquer poliment (« Nous fabriquons au dixième de mètre près, nous avons donc retenu 4,2 m. »).
ARRONDI SURFACE : arrondir UNIQUEMENT le résultat final au DIXIÈME.
   Ex : 9,24 m² → 9,2 m² ; 7,805 m² → 7,8 m².
   ⚠️ NE PAS arrondir les valeurs intermédiaires (sinon double arrondi → sous-facturation).

═══════════════════════════════════════════════════
"""

# Pattern : tout le bloc dupliqué (depuis "Calcul surface : Rectangle" jusqu'à "N'arrondir QUE le résultat final de la surface, au dixième.")
# On capture le bloc avec un look-behind/ahead pour le supprimer proprement
DUPLICATE_BLOCK_RE = re.compile(
    r"\n*Calcul surface : Rectangle = L×l \| Triangle = \(b×h\)/2 \| Trapèze = \(\(B\+b\)×h\)/2\n"
    r"ARRONDI DIMENSIONS :.*?\n"
    r"ARRONDI SURFACE :.*?\n"
    r"\n*CALCUL SURFACE — méthodes par forme :\n"
    r"  \* Rectangle : L × l\n"
    r"  \* Triangle donné par BASE \+ HAUTEUR : \(b × h\) / 2\n"
    r"  \* Triangle donné par les 3 CÔTÉS .*?\n"
    r"      → utiliser la FORMULE DE HÉRON .*?\n"
    r"         s = \(a \+ b \+ c\) / 2\n"
    r"         surface = √.*?\n"
    r"      → NE PAS deviner.*?\n"
    r"  \* Trapèze : .*?\n"
    r"  *\n"
    r"N'arrondir QUE le résultat final de la surface, au dixième\.\n*",
    re.DOTALL
)

def get_file(store, name):
    sql = f"""SELECT content FROM agent_files af
              JOIN agents a ON a.id = af.agent_id
              WHERE a.store_code = '{store}' AND af.name = '{name}';"""
    return subprocess.check_output(["psql", DATABASE_URL, "-At", "-c", sql], text=True)

def upsert(store, name, content):
    tmp = Path(f"/tmp/_heron_{store}.txt")
    tmp.write_text(content, encoding="utf-8")
    sql = f"""
\\set c `cat {tmp}`
UPDATE agent_files SET content = :'c'
WHERE name = '{name}' AND agent_id = (SELECT id FROM agents WHERE store_code = '{store}');
"""
    subprocess.run(["psql", DATABASE_URL], input=sql, text=True, check=True, capture_output=True)

def patch_content(content):
    # 1. Supprimer TOUTES les occurrences du bloc d'arrondi/calcul (souvent dupliqué)
    new = DUPLICATE_BLOCK_RE.sub("\n", content)
    removed = len(re.findall(DUPLICATE_BLOCK_RE, content))
    # 2. Insérer le nouveau bloc Héron juste après le bloc d'en-tête
    #    On cherche le "═══════════════════════════════════════════════════" de fin d'en-tête,
    #    ou à défaut juste après le titre
    header_end_re = re.compile(r"(═══════════════════════════════════════════════════\nPRIX HT SUR-MESURE.*?\n═══════════════════════════════════════════════════\n)", re.DOTALL)
    m = header_end_re.search(new)
    if m:
        insertion_point = m.end()
        new = new[:insertion_point] + "\n" + HERON_HEADER + "\n" + new[insertion_point:]
    else:
        # Fallback : juste tout en haut
        new = HERON_HEADER + "\n" + new
    # 3. Cleanup excessive blank lines
    new = re.sub(r"\n{4,}", "\n\n\n", new)
    return new, removed

def main():
    for store in STORES:
        print(f"━━━ {store} ━━━")
        cur = get_file(store, "prix-ht-sur-mesure.txt")
        if not cur:
            print(f"  ⚠️  fichier vide ou inexistant — skip")
            continue
        new, removed = patch_content(cur)
        delta = len(new) - len(cur)
        print(f"  bloc dupliqué supprimé : {removed}× | header Héron inséré | Δ taille = {delta:+d} octets")
        upsert(store, "prix-ht-sur-mesure.txt", new)
        print(f"  ✅ {store} mis à jour ({len(new)} octets)")
        # Smoke check
        if "Triangle = (b×h)/2" in new:
            print(f"  ❌ WARNING : phrase trompeuse encore présente !")
        if "FORMULE DE HÉRON" not in new:
            print(f"  ❌ WARNING : règle Héron absente !")
        if "9,24 m² → arrondi" not in new:
            print(f"  ❌ WARNING : exemple chiffré absent !")
        print()

if __name__ == "__main__":
    main()
