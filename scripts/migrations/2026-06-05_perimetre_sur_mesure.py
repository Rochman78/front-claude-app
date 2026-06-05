#!/usr/bin/env python3
"""
Fix : ajouter une règle stricte sur le PÉRIMÈTRE du sur-mesure dans le bloc
RÈGLES PRIORITAIRES des 9 boutiques.

Cas Olivier RUF (cnv_1lkmf9cn, LFC, 04/06/2026) : Claude/Murella a écrit
"Ce type d'adaptation est une option sur mesure que nous pouvons tout à
fait étudier" en réponse à une demande de câble interne traversant un
filet + 2 anneaux supplémentaires. FAUX — l'atelier ne fait que les
caractéristiques standard (forme, dimensions, finition, ignifugé, couleur).

On insère un nouveau bloc "PÉRIMÈTRE DU SUR-MESURE — LIMITATION STRICTE"
juste après la règle 1 (STANDARD vs SUR MESURE) pour qu'il soit lu dans
la foulée.
"""
import re, subprocess
from pathlib import Path

DATABASE_URL = subprocess.check_output(
    "grep DATABASE_URL /Users/charlesbamy/front-claude-app/.env | cut -d= -f2-",
    shell=True
).decode().strip()

STORES = ["LFC", "LVO", "MON", "UNI", "TAR", "HET", "RED", "RETE", "COCO"]

NEW_RULE = """
PÉRIMÈTRE DU SUR-MESURE — LIMITATION STRICTE :
Le sur-mesure consiste UNIQUEMENT à choisir parmi ces caractéristiques standard :
  • FORME (rectangle, carré, triangle, trapèze)
  • DIMENSIONS exactes (au dixième de mètre)
  • FINITION du contour (corde polyester 6 mm OU câble acier)
  • COULEUR (parmi les couleurs catalogue de la finition choisie)
  • IGNIFUGÉ (oui / non, uniquement sable ou blanc)
TOUTE AUTRE personnalisation est IMPOSSIBLE (l'atelier ne le fait pas), notamment :
  ❌ câble ou renfort INTERNE traversant le filet
  ❌ anneaux / mousquetons / œillets supplémentaires ailleurs qu'aux 4 coins
  ❌ ouvertures, fenêtres, découpes, séparations
  ❌ doublure, multi-couches, pochettes
  ❌ logos, impressions, broderies, marquages
  ❌ pose, installation, fixation murale (le client installe lui-même)
Comportement attendu : si le client demande une modification hors périmètre,
REFUSER POLIMENT en expliquant que le sur-mesure se limite aux 5 caractéristiques
ci-dessus, puis PROPOSER une alternative réaliste : filet standard ou sur-mesure
classique + accessoires séparés (câble acier au mètre, mousquetons, ridoirs, kits
de fixation) que le client installera lui-même par l'extérieur du filet.
NE JAMAIS écrire « nous pouvons étudier », « c'est faisable sur mesure »,
« nous transmettons à l'atelier » pour une modification hors périmètre — ces
formulations créent une fausse attente côté client.

"""

def get_instructions(store):
    sql = f"SELECT instructions FROM agents WHERE store_code='{store}';"
    return subprocess.check_output(["psql", DATABASE_URL, "-At", "-c", sql], text=True)

def update_instructions(store, content):
    tmp = Path(f"/tmp/_agent_{store}.txt")
    tmp.write_text(content, encoding="utf-8")
    sql = f"""
\\set c `cat {tmp}`
UPDATE agents SET instructions = :'c' WHERE store_code = '{store}';
"""
    subprocess.run(["psql", DATABASE_URL], input=sql, text=True, check=True, capture_output=True)

def patch(content):
    if "PÉRIMÈTRE DU SUR-MESURE — LIMITATION STRICTE" in content:
        return content, False, "déjà appliqué"
    # On insère juste APRÈS la règle 1 (STANDARD vs SUR MESURE) — repérée par le
    # début de la règle 2 "2. WORKFLOW :"
    pattern = re.compile(r"\n(2\. WORKFLOW :)", re.MULTILINE)
    m = pattern.search(content)
    if not m:
        return content, False, "marqueur '2. WORKFLOW :' introuvable"
    insert_at = m.start()
    new = content[:insert_at] + NEW_RULE + content[insert_at:]
    return new, True, "OK"

def main():
    for store in STORES:
        print(f"━━━ {store} ━━━")
        cur = get_instructions(store)
        if not cur:
            print(f"  ⚠️  pas d'instructions — skip")
            continue
        new, did, reason = patch(cur)
        if not did:
            print(f"  ⚠️  {reason}")
            continue
        delta = len(new) - len(cur)
        update_instructions(store, new)
        re_check = get_instructions(store)
        ok = ("PÉRIMÈTRE DU SUR-MESURE — LIMITATION STRICTE" in re_check
              and "câble ou renfort INTERNE" in re_check
              and "NE JAMAIS écrire « nous pouvons étudier »" in re_check)
        status = "✅" if ok else "❌"
        print(f"  {status} {store} règle ajoutée (Δ={delta:+d} octets, total {len(re_check)})")

if __name__ == "__main__":
    main()
