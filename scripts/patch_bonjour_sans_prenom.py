#!/usr/bin/env python3
"""
Patch pour retirer complètement le prénom après « Bonjour » dans tous les
brouillons agents × 10 boutiques. Charles 03/07/2026 : « ne mets plus le
prénom après le bonjour sur toutes les boutiques, ya trop d'erreur, tu
peux mettre juste bonjour ».

Sources d'erreurs récurrentes :
- Confusion prénom/nom (« Bonjour Dupont, » au lieu de « Bonjour Jean, »)
- Contamination inter-messages (prend le prénom d'un mail cité)
- Nom générique interprété à tort comme prénom (« Bonjour Direction, »)
- Casse / accents / féminisation erronée
- Compte de service ou boîte partagée pris pour un prénom

Fix — 2 changements en cascade × 10 boutiques :

1. RÈGLE META sur la salutation (ligne ~972) : remplacer la règle
   « Bonjour [Prénom] si prénom identifiable, sinon Bonjour » par une
   règle stricte « Bonjour, » toujours seul, sans exception.

2. TEMPLATES qui contiennent « Bonjour [Prénom], » → remplacer par
   « Bonjour, » (7 occurrences typiques dans les templates SAV / rupture
   / accusé de réception / relance).

Backup pré-patch :
  backups/bonjour-sans-prenom-<timestamp>/agents_instructions_backup.json
"""
import os
import sys
import psycopg2
from datetime import datetime

# --- 1. Ancienne règle META sur la salutation ---
OLD_META_LINE = (
    '- "Bonjour [Prénom]," — uniquement avec un VRAI PRÉNOM DE PERSONNE '
    '(Marie, Jean, Yoan, Anaïs, Patricia, etc.). Si pas de prénom identifiable, '
    'OU si le mail vient d\'un compte/fonction générique (« Secrétaire Générale '
    'Baron », « Direction », « Service Achats », « Accueil », « Mairie », '
    '« Association X », etc.) → écrire JUSTE « Bonjour, » sans aucun nom ni '
    'qualificatif. NE JAMAIS écrire « Bonjour Secrétaire, », « Bonjour '
    'Direction, », « Bonjour Monsieur le Maire, », « Bonjour Madame, », '
    '« Bonjour Monsieur, », « Bonjour Madame Dupont, » — TOUJOURS un vrai '
    'prénom SEUL ou RIEN. La forme « Bonjour [titre/fonction], » est '
    'interdite sans exception.'
)

NEW_META_LINE = (
    '- SALUTATION : TOUJOURS « Bonjour, » seul, sans exception. NE JAMAIS '
    'écrire de prénom, nom, titre ou fonction après le « Bonjour ». '
    'Interdit sans exception : « Bonjour Jean, », « Bonjour Mme Dupont, », '
    '« Bonjour Direction, », « Bonjour Monsieur, », etc. — TOUJOURS « Bonjour, » '
    'seul. Raison (Charles 03/07/2026) : trop d\'erreurs récurrentes '
    '(confusion prénom/nom, contamination inter-messages, boîte de service '
    'prise pour un prénom, casse/accents erronés). La formule « Bonjour, » '
    'neutre est plus sûre et parfaitement acceptable en français service '
    'client. La traduction au push adapte automatiquement (« Hallo, » DE / '
    '« Goedendag, » NL / « Buenos días, » ES / « Buongiorno, » IT / '
    '« Bom dia, » PT).'
)


def apply_patch(instructions: str) -> tuple[str, int]:
    """Retourne (nouvelles_instructions, nombre_de_remplacements_effectués).
    Compte à la fois la règle META (1) et les occurrences de templates."""
    total = 0
    out = instructions

    # 1. Règle META (1 seule occurrence attendue)
    if OLD_META_LINE in out:
        out = out.replace(OLD_META_LINE, NEW_META_LINE)
        total += 1

    # 2. Templates : « Bonjour [Prénom], » → « Bonjour, »
    # Cas exacts observés dans le fichier (avec/sans espace après crochet,
    # avec/sans virgule majuscule, etc.). On fait des remplacements ciblés
    # sur les patterns les plus courants.
    template_replacements = [
        ("Bonjour [Prénom],", "Bonjour,"),
        ("Bonjour [Prénom] ,", "Bonjour,"),
        ("Bonjour [Prénom]", "Bonjour"),
        ("« Bonjour [Prénom],", "« Bonjour,"),
    ]
    for old, new in template_replacements:
        count = out.count(old)
        if count > 0:
            out = out.replace(old, new)
            total += count

    return out, total


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
        new_instructions, count = apply_patch(instructions)
        if count == 0:
            skipped.append(store_code)
            continue
        updates.append((store_code, new_instructions, count))

    print(f"À patcher : {len(updates)} ({[u[0] for u in updates]})")
    print(f"Sautées (rien à remplacer) : {len(skipped)} ({skipped})")

    for store_code, new_instructions, count in updates:
        cur.execute(
            "UPDATE agents SET instructions = %s WHERE store_code = %s",
            (new_instructions, store_code),
        )
        print(f"  ✓ {store_code} : {len(new_instructions)} chars, {count} remplacements")

    conn.commit()
    cur.close()
    conn.close()
    print(f"\nOK — {len(updates)} boutiques patchées le {datetime.now().isoformat(timespec='seconds')}")


if __name__ == "__main__":
    main()
