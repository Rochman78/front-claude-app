#!/usr/bin/env python3
"""
Patch le bloc COORDONNÉES dans agents.instructions × 10 boutiques pour
distinguer adresse de facturation et adresse de livraison.

Change :
    - COORDONNÉES : nom, prénom (ou raison sociale), adresse, email, téléphone.
→
    - COORDONNÉES : nom, prénom (ou raison sociale), adresse de facturation,
      adresse de livraison (si différente de la facturation), email, téléphone.

Et ajoute juste après un bloc dédié « ADRESSE DE FACTURATION vs ADRESSE DE
LIVRAISON » qui explique comment demander / afficher les 2 adresses dans le
brouillon client (règle Q3 : toujours afficher les 2 lignes, même identiques).

Backup pré-patch : backups/adresse-facturation-livraison-<timestamp>/
                   agents_instructions_backup.json
"""
import os
import sys
import psycopg2
from datetime import datetime

OLD_LINE = "- COORDONNÉES : nom, prénom (ou raison sociale), adresse, email, téléphone."

NEW_LINE = (
    "- COORDONNÉES : nom, prénom (ou raison sociale), adresse de facturation, "
    "adresse de livraison (si différente de la facturation), email, téléphone."
)

# Bloc dédié à insérer JUSTE après la nouvelle ligne COORDONNÉES. Explique le
# comportement attendu côté brouillon client :
# - toujours demander les 2 adresses (facturation + livraison)
# - dans le récap coordonnées du chiffrage, TOUJOURS afficher les 2 lignes,
#   même si identiques (règle Q3 Charles 02/07/2026 — préférence explicite
#   sur la lisibilité, quitte à être redondant)
# - si le client n'a donné qu'une adresse → répliquer sur les 2 lignes en
#   flagant en QUESTIONS pour confirmation
NEW_BLOCK = """
═══════════════════════════════════════
⚠️ ADRESSE DE FACTURATION vs ADRESSE DE LIVRAISON — TOUJOURS LES DEUX DANS LE BROUILLON
═══════════════════════════════════════

Un client peut avoir 2 adresses distinctes :
- Adresse de FACTURATION : celle qui apparaît sur le PDF Pennylane pour la comptabilité (siège social pour une entreprise, domicile administratif pour un particulier).
- Adresse de LIVRAISON : celle où le colis est envoyé (chantier, entrepôt, second domicile, adresse temporaire…).

RÈGLE ABSOLUE — dans le RÉCAP COORDONNÉES à la fin du chiffrage client, tu affiches TOUJOURS les 2 lignes, même si le client n'a donné qu'une adresse (dans ce cas les 2 lignes sont identiques). Ne pas fusionner en une seule ligne « Adresse : … ». Cela protège contre les erreurs de livraison à la mauvaise adresse et rend visible au client où sera envoyé le colis.

FORMAT OBLIGATOIRE dans le récap coordonnées :

  Nom :
  Prénom :
  Adresse de facturation :
  Adresse de livraison :
  Email :
  Numéro de téléphone :

COMPORTEMENT selon le cas :

1. Le client a donné UNE seule adresse (cas 90 %) :
   → Adresse de facturation = adresse de livraison = celle donnée.
   → Les 2 lignes du récap portent le même contenu.
   → Aucune question, on ne complique pas.

2. Le client a EXPLICITEMENT demandé une livraison à une autre adresse (« à livrer à », « livraison à », « chantier à », « merci de livrer chez… ») :
   → Facturation = adresse principale du client.
   → Livraison = adresse mentionnée pour la livraison.
   → Les 2 lignes du récap sont DIFFÉRENTES.

3. Le client a donné son nom et téléphone mais AUCUNE adresse :
   → Demander UNE seule adresse en lui précisant qu'elle sera utilisée pour la facturation ET la livraison, et lui demander s'il souhaite une adresse de livraison distincte : « Merci de nous transmettre votre adresse de facturation, ainsi que votre adresse de livraison si elle diffère. »

INTERDICTIONS ABSOLUES :
- Fusionner facturation et livraison en une seule ligne « Adresse : » dans le récap coordonnées.
- Omettre l'une des 2 lignes sous prétexte qu'elles sont identiques.
- Inventer une adresse de livraison distincte quand le client n'en a pas mentionné.

═══════════════════════════════════════
"""


def replace_line(instructions: str) -> tuple[str, bool]:
    if OLD_LINE not in instructions:
        return instructions, False
    # Substitution + injection du bloc explicatif juste après la ligne modifiée
    replacement = NEW_LINE + "\n" + NEW_BLOCK
    return instructions.replace(OLD_LINE, replacement), True


def main():
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
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
        new_instructions, changed = replace_line(instructions)
        if not changed:
            skipped.append(store_code)
            continue
        updates.append((store_code, new_instructions))

    print(f"À patcher : {len(updates)} ({[u[0] for u in updates]})")
    print(f"Sautées (ligne COORDONNÉES absente) : {len(skipped)} ({skipped})")

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
