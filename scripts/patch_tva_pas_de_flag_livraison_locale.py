#!/usr/bin/env python3
"""
Patch pour interdire à Claude de flagger inutilement en 🟠 ATTENTION que la
TVA 20 % est appliquée alors que le client a fourni un n° TVA intra. Cas
Charles 03/07/2026 (cnv_1ls66p1z) : brouillon avec TVA 20 % correctement
appliquée (livraison en France, client français avec n° TVA FR), mais
Claude a rajouté « 🟠 ATTENTION — TVA à 20 % appliquée malgré le numéro TVA
intracommunautaire fourni... Confirmes-tu ? » → polluant les QUESTIONS pour
un cas totalement standard.

La règle par défaut est déjà bien définie (livraison FR → TVA FR 20 %), il
manque juste l'anti-flag pour ne pas polluer QUESTIONS quand c'est
sans ambiguïté.

On enrichit le bloc EXCEPTION (B2B INTRACOMMUNAUTAIRE) avec une
sous-section explicite « NE PAS FLAGGER EN QUESTIONS ».

Backup pré-patch :
  backups/tva-fr-livraison-fr-pas-de-flag-<timestamp>/
    agents_instructions_backup.json
"""
import os
import sys
import psycopg2
from datetime import datetime

OLD_TEXT = (
    "EXCEPTION (B2B INTRACOMMUNAUTAIRE) :\n"
    "Si le client fournit un numéro de TVA intracommunautaire VALIDE + adresse UE hors France (boutique FR) ou hors pays de la boutique (boutique étrangère) → TVA = 0 % + mention légale Article 138 de la Directive 2006/112/CE. Ce régime est déjà géré dans le code Pennylane, ne pas le modifier."
)

NEW_TEXT = (
    "EXCEPTION (B2B INTRACOMMUNAUTAIRE) :\n"
    "Si le client fournit un numéro de TVA intracommunautaire VALIDE + adresse UE hors France (boutique FR) ou hors pays de la boutique (boutique étrangère) → TVA = 0 % + mention légale Article 138 de la Directive 2006/112/CE. Ce régime est déjà géré dans le code Pennylane, ne pas le modifier.\n"
    "\n"
    "⛔ NE PAS FLAGGER EN QUESTIONS QUAND LA TVA N'EST PAS AMBIGUË :\n"
    "\n"
    "Ne JAMAIS émettre en QUESTIONS un flag 🟠 ATTENTION ou 🔴 BLOQUANT sur l'application de la TVA quand la situation est SANS AMBIGUÏTÉ. Les cas suivants sont TOUJOURS corrects, ne les flagge PAS :\n"
    "  1. Livraison en France + client avec ou sans n° TVA intra (français FRxxxxxxxxx ou étranger) → TVA FR 20 %, PAS de flag. La règle LIC (0 %) NE S'APPLIQUE PAS pour une livraison en France, quel que soit le n° TVA intra fourni. C'est le cas standard, aucune vérification à demander.\n"
    "  2. Livraison en Italie + client italien avec ou sans n° TVA IT → TVA IT 22 %, PAS de flag. Idem pour toutes les livraisons dans le pays de résidence du client.\n"
    "  3. Livraison UE hors pays boutique + n° TVA intra valide → TVA 0 % LIC, PAS de flag (c'est l'application normale du régime intracommunautaire).\n"
    "  4. Livraison hors UE → TVA 0 % export, PAS de flag (règle standard).\n"
    "\n"
    "QUAND UN FLAG EST LÉGITIME (rare) :\n"
    "  - Adresse de livraison AMBIGUË ou multiple, plusieurs pays possibles → 🟠 ATTENTION : « Quelle adresse de livraison retenir ? Adresse A (FR) ou B (BE) ? Cela change la TVA appliquée. »\n"
    "  - Client UE hors pays boutique SANS n° TVA intra fourni → PAS de flag automatique (TVA du pays de livraison par défaut, c'est légal), sauf si le client a mentionné qu'il est PRO et voulait le régime intra → 🟠 ATTENTION : « Client mentionne être pro sans fournir de n° TVA intra. Demander le n° pour appliquer 0 % LIC, ou confirmer TVA locale par défaut ? »\n"
    "  - Pays de livraison hors UE mais n° TVA intra fourni → 🟢 INFO : « Livraison hors UE (TVA 0 % export). Le n° TVA intra ne s'applique pas ici. »\n"
    "\n"
    "Cas déclencheur (à NE PAS reproduire) : cnv_1ls66p1z (LFC, 03/07/2026) — client français FR53213105554 + livraison en France. Brouillon TVA 20 % correcte, MAIS Claude a rajouté en QUESTIONS : « 🟠 ATTENTION — TVA à 20 % appliquée malgré le numéro TVA intracommunautaire fourni... Confirmes-tu ? ». Aucune ambiguïté ici, aucun flag nécessaire, ça pollue la section QUESTIONS. Le gérant lit et se dit « pourquoi il me demande ça ? »."
)


def apply_patch(instructions: str) -> tuple[str, bool]:
    if OLD_TEXT not in instructions:
        return instructions, False
    # Si le patch a déjà été appliqué, ne pas le refaire
    if "NE PAS FLAGGER EN QUESTIONS QUAND LA TVA N'EST PAS AMBIGUË" in instructions:
        return instructions, False
    return instructions.replace(OLD_TEXT, NEW_TEXT), True


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
        new_instructions, changed = apply_patch(instructions)
        if not changed:
            skipped.append(store_code)
            continue
        updates.append((store_code, new_instructions))

    print(f"À patcher : {len(updates)} ({[u[0] for u in updates]})")
    print(f"Sautées (marqueur absent ou patch déjà appliqué) : {len(skipped)} ({skipped})")

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
