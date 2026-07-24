#!/usr/bin/env python3
"""Ajoute l'adresse physique de retour (C-Logistics, Cestas) dans
agents.instructions × 10 boutiques, avec garde-fous stricts.

Règle métier — l'adresse ne se donne au client QUE si :
  1) le client a formellement demandé un retour
  2) le gérant a validé la demande
  3) le gérant a envoyé l'étiquette de retour au client

Idempotent : ne double-patch pas si 'C-Logistics' est déjà présent.
"""
import psycopg2

env_path = '/Users/charlesbamy/front-claude-app/.env'
with open(env_path) as f:
    for line in f:
        if line.startswith('DATABASE_URL='):
            db_url = line.split('=', 1)[1].strip()
            break

MARKER = "- Produits sur mesure EXCLUS du retour (ne pas mentionner en première intention)."

NEW_BULLET = (
    "\n- ADRESSE PHYSIQUE DE RETOUR — entrepôt partenaire : "
    "C-Logistics, Service des retours, ZA Pot au Pin, 33613 CESTAS CEDEX. "
    "⚠️ NE JAMAIS communiquer cette adresse au client en première intention, "
    "ni dans un brouillon spontané. Elle ne se donne QUE quand les 3 conditions "
    "sont réunies : (1) le client a formellement demandé un retour, "
    "(2) le gérant a validé la demande, (3) le gérant a envoyé au client "
    "l'étiquette de retour prépayée. Tant qu'une seule de ces conditions "
    "manque, réponse standard = phrase neutre « nous revenons vers vous avec "
    "les instructions de retour » + flag QUESTIONS pour que le gérant tranche. "
    "NE JAMAIS renvoyer le client au siège social 5 rue Fénelon — les retours "
    "n'y sont PAS traités. L'étiquette de retour prépayée, elle, est toujours "
    "envoyée par le gérant dans un mail séparé (pas par l'agent)."
)

REPLACEMENT = MARKER + NEW_BULLET

STORES = ('LFC', 'LVO', 'COCO', 'MON', 'UNI', 'TAR', 'HET', 'RED', 'REDE', 'RETE')

with psycopg2.connect(db_url) as conn:
    with conn.cursor() as cur:
        for store in STORES:
            cur.execute("SELECT id, instructions FROM agents WHERE store_code = %s", (store,))
            aid, instr = cur.fetchone()
            if 'C-Logistics' in instr:
                print(f"[{store}] déjà patché — skip")
                continue
            assert MARKER in instr, f"marker introuvable dans {store}"
            new = instr.replace(MARKER, REPLACEMENT, 1)
            assert 'C-Logistics' in new and 'CESTAS CEDEX' in new
            cur.execute("UPDATE agents SET instructions = %s WHERE id = %s", (new, aid))
            print(f"[{store}] patché : {len(instr)} → {len(new)} chars (+{len(new)-len(instr)})")
    conn.commit()
print("OK")
