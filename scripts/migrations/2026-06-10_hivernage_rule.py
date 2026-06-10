#!/usr/bin/env python3
"""
Ajoute une règle "HIVERNAGE OBLIGATOIRE — INSTALLATION PERMANENTE DÉCONSEILLÉE"
aux instructions des 9 agents.

Cas déclencheur (cnv_1llr6snr, 10/06/2026) : M. RISSO demande un devis pour
2 filets 7x10 sable câble acier et précise "nous voulons le laisser à l'année".
L'agent doit lui recommander l'hivernage et déconseiller l'installation permanente
(c'est ce que dit la fiche technique produit : "Instal. permanente : Non recommandé").

La règle est insérée juste après la règle "6. PRIORITÉ GÉRANT" pour rester dans la
zone des règles de comportement, sans renuméroter le reste.
"""
import re, subprocess
from pathlib import Path

DATABASE_URL = subprocess.check_output(
    "grep DATABASE_URL /Users/charlesbamy/front-claude-app/.env | cut -d= -f2-",
    shell=True
).decode().strip()

STORES = ["LFC", "LVO", "MON", "UNI", "TAR", "HET", "RED", "RETE", "COCO"]

NEW_RULE = """
HIVERNAGE OBLIGATOIRE — INSTALLATION PERMANENTE DÉCONSEILLÉE :
Si le client mentionne explicitement vouloir laisser le produit installé en permanence
(formulations type : « laisser à l'année », « toute l'année », « ne pas l'enlever »,
« en permanence », « installation fixe », « définitif », équivalents multilingues),
l'agent DOIT, dans le brouillon de réponse, signaler poliment que :
  • L'INSTALLATION PERMANENTE N'EST PAS RECOMMANDÉE pour nos produits
    (cf. fiche technique : « Instal. permanente : Non recommandé »).
  • Nous recommandons fortement un HIVERNAGE : retirer le produit en saison froide
    (typiquement octobre → mars selon région) et le stocker au sec.
  • En cas d'épisode de VENTS FORTS, NEIGE ou TEMPÊTE, retirer également le produit.
  • Le non-respect de ces recommandations entraîne une usure prématurée et peut
    affecter la prise en charge en garantie.

Formulation type à intégrer dans le brouillon (juste après le chiffrage, avant les
coordonnées) :
« Vous nous indiquez vouloir laisser le filet à l'année. Nous tenons à vous informer
que l'installation permanente n'est pas recommandée pour nos produits. Nous conseillons
un hivernage en saison froide (retirer et stocker au sec) ainsi qu'un retrait lors des
épisodes de vents forts ou de neige. Le respect de ces préconisations prolonge
considérablement la durée de vie du produit et préserve la garantie. »

NE PAS être moralisateur. Le mentionner UNE SEULE FOIS, poliment. Si le client maintient
son intention après cette précision, ne PAS insister — on a fait notre devoir d'information.

"""

def get_inst(store):
    sql = f"SELECT instructions FROM agents WHERE store_code='{store}';"
    return subprocess.check_output(["psql", DATABASE_URL, "-At", "-c", sql], text=True)

def update_inst(store, content):
    tmp = Path(f"/tmp/_inst_{store}.txt")
    tmp.write_text(content, encoding="utf-8")
    sql = f"""
\\set c `cat {tmp}`
UPDATE agents SET instructions = :'c' WHERE store_code = '{store}';
"""
    subprocess.run(["psql", DATABASE_URL], input=sql, text=True, check=True, capture_output=True)

def patch(content):
    if "HIVERNAGE OBLIGATOIRE — INSTALLATION PERMANENTE DÉCONSEILLÉE" in content:
        return content, False, "déjà appliqué"
    # Insertion : juste avant la ligne "7." ou avant "═══" qui suit la règle 6
    # Plus simple : on cherche "6. PRIORITÉ GÉRANT" et on insère après le bloc de la règle 6.
    # La règle 6 se termine au prochain saut de paragraphe (\n\n) suivi d'un chiffre.
    m = re.search(r"(6\. PRIORITÉ GÉRANT.*?)(\n\n)(?=\d+\. |═)", content, re.DOTALL)
    if not m:
        # Fallback : on cherche le séparateur principal ou la fin du bloc RÈGLES
        m2 = re.search(r"(═══════════════════════════════════════\n[^═].*?)(═══════════════════════════════════════)", content, re.DOTALL)
        if not m2:
            return content, False, "marqueur insertion introuvable"
        return content, False, "fallback à coder"
    insert_at = m.end(1)  # juste après la règle 6, avant le \n\n
    new = content[:insert_at] + "\n\n" + NEW_RULE.strip() + content[insert_at:]
    return new, True, "OK"

def main():
    for store in STORES:
        print(f"━━━ {store} ━━━")
        cur = get_inst(store)
        if not cur:
            print(f"  ⚠️  pas d'instructions — skip")
            continue
        new, did, reason = patch(cur)
        if not did:
            print(f"  ⚠️  {reason}")
            continue
        delta = len(new) - len(cur)
        update_inst(store, new)
        # Verify
        re_check = get_inst(store)
        ok = "HIVERNAGE OBLIGATOIRE" in re_check and "INSTALLATION PERMANENTE N'EST PAS RECOMMANDÉE" in re_check
        status = "✅" if ok else "❌"
        print(f"  {status} {store} (Δ={delta:+d} octets, total {len(re_check)})")

if __name__ == "__main__":
    main()
