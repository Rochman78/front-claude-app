#!/usr/bin/env python3
"""
Fix : ajouter un préambule "PROCESS DEVIS — étapes obligatoires" en TÊTE des
instructions agents, AVANT le bloc "⚠️ RÈGLES PRIORITAIRES", pour empêcher
Claude de commencer à rédiger un brouillon sur-mesure puis de se "corriger"
en cours de mail avec [⚠️ STOP] ou "Correction :" (cas Jaap BOTH cnv_1lkfuqzb).

Le préambule force la séquence :
   1° classification (standard vs sur-mesure, en testant taille inversée)
   2° lecture du bon prix (TTC catalogue OU grille sur-mesure)
   3° rédaction du brouillon SEULEMENT après ces 2 étapes.

Appliqué aux 9 boutiques.
"""
import re, subprocess
from pathlib import Path

DATABASE_URL = subprocess.check_output(
    "grep DATABASE_URL /Users/charlesbamy/front-claude-app/.env | cut -d= -f2-",
    shell=True
).decode().strip()

STORES = ["LFC", "LVO", "MON", "UNI", "TAR", "HET", "RED", "RETE", "COCO"]

PREAMBLE = """═══════════════════════════════════════
⚠️ PROCESS DEVIS — ÉTAPES OBLIGATOIRES (à suivre AVANT toute rédaction)
═══════════════════════════════════════

Pour CHAQUE demande de devis, exécuter cette séquence DANS L'ORDRE — JAMAIS commencer à écrire un prix dans le brouillon avant d'avoir terminé les étapes 1 et 2 :

ÉTAPE 1 — CLASSIFICATION CATALOGUE (silencieusement, AVANT d'écrire la 1re ligne du mail)
   Pour CHAQUE filet demandé :
   1.a Tester la combinaison COMPLÈTE (taille + couleur + finition) dans le catalogue avec la taille EXACTE (ex : 6x4)
   1.b Tester la taille INVERSÉE (ex : 4x6) — RAPPEL : 3x4=4x3, 2x5=5x2, 6x4=4x6, etc.
   1.c Verdict pour chaque filet :
       → STANDARD si la combinaison COMPLÈTE existe (taille normale ou inversée)
       → SUR-MESURE si AUCUNE correspondance, MÊME inversée

ÉTAPE 2 — LECTURE DU BON PRIX
   • Si STANDARD → ouvrir prix-ht-standards.txt OU catalogue pour le TTC, prix par pièce. NE PAS appliquer la grille sur-mesure.
   • Si SUR-MESURE → ouvrir prix-ht-sur-mesure.txt, calculer surface (Héron pour triangle 3 côtés), choisir la bonne tranche, lire HT/m².

ÉTAPE 3 — RÉDACTION DU BROUILLON
   Seulement maintenant, écrire le mail au client avec le bon prix du premier coup.

⚠️ INTERDICTIONS ABSOLUES :
- Commencer à écrire un prix sur-mesure puis se « corriger » en cours de mail avec [⚠️ STOP], « Correction : », « En fait c'est standard », etc. → le gérant reçoit un brouillon incohérent et illisible. Le brouillon DOIT être bon DU PREMIER COUP.
- Appliquer la grille sur-mesure à une taille qui existe au catalogue (même inversée) — cas typique Jaap BOTH 04/06/2026 : 6x4 beige polyester chiffré à 197,49 €/m² (halluciné), alors que 4x6 beige polyester existe au catalogue à 236,99 € TTC.
- Inventer un prix au m² qui ne figure pas dans la grille sur-mesure documentée.

═══════════════════════════════════════

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

MARKER = "⚠️ RÈGLES PRIORITAIRES"

def patch(content):
    # Skip si déjà appliqué
    if "PROCESS DEVIS — ÉTAPES OBLIGATOIRES" in content:
        return content, False, "déjà appliqué"
    # Trouve la position du bloc "═══...⚠️ RÈGLES PRIORITAIRES..."
    # On insère le préambule JUSTE AVANT le séparateur "═══" qui précède "⚠️ RÈGLES PRIORITAIRES"
    pattern = re.compile(r"(═══════════════════════════════════════\n⚠️ RÈGLES PRIORITAIRES)", re.MULTILINE)
    m = pattern.search(content)
    if not m:
        return content, False, "marqueur '⚠️ RÈGLES PRIORITAIRES' introuvable"
    new = content[:m.start()] + PREAMBLE + content[m.start():]
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
        if "PROCESS DEVIS — ÉTAPES OBLIGATOIRES" in re_check and "INTERDICTIONS ABSOLUES" in re_check:
            print(f"  ✅ {store} préambule inséré (Δ={delta:+d} octets, total {len(re_check)})")
        else:
            print(f"  ❌ {store} vérification échouée !")

if __name__ == "__main__":
    main()
