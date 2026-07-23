#!/usr/bin/env python3
"""
Patch prix-ht-standards.txt pour LFC et COCO :
- Ajoute "mât en bois" à la liste de la colonne 2 (forme) en tête de fichier
- Ajoute "bois" à la liste de la colonne 3 (matiere) en tête de fichier
- Insère la ligne SKU 3770043027001 (219,99 € TTC) juste après la ligne
  "mât télescopique" (LFC uniquement — COCO n'a pas de bloc accessoire mât,
  on insère alors à la fin de la section accessoires COCO).
"""
import os
import psycopg2

# Charge DATABASE_URL depuis .env
env_path = '/Users/charlesbamy/front-claude-app/.env'
with open(env_path) as f:
    for line in f:
        if line.startswith('DATABASE_URL='):
            db_url = line.split('=', 1)[1].strip()
            break

# Nouvelle ligne à insérer, alignée sur la ligne "mât télescopique"
NEW_LINE = (
    "accessoire  | mât en bois        | bois         | naturel      | 1 pièce    "
    "| 3770043027001  |  219.99 |  219.99 |  188.03 |  186.43 |  184.87 |  183.33 "
    "|  181.81 |  180.32 |  178.85 |  177.41 |  175.99 |   175.29 |  173.22"
)

def patch(content: str) -> str:
    # 1) Colonne 2 (forme) — ajoute "mât en bois" juste après "mât télescopique"
    content = content.replace(
        "mât télescopique | base ancrage",
        "mât télescopique | mât en bois | base ancrage",
        1,
    )
    # 2) Colonne 3 (matière) — ajoute "bois" avant "n/a"
    content = content.replace(
        "polyester | câble acier | coco | acier | n/a",
        "polyester | câble acier | coco | acier | bois | n/a",
        1,
    )
    # 3) Insère la ligne accessoire mât en bois après la ligne mât télescopique
    lines = content.split('\n')
    out = []
    inserted = False
    for i, line in enumerate(lines):
        out.append(line)
        if not inserted and 'mât télescopique' in line and line.startswith('accessoire'):
            out.append(NEW_LINE)
            inserted = True
    # Fallback COCO (pas de ligne mât télescopique) : insérer après la ligne
    # accessoire | corde | coco | naturel | 20m
    if not inserted:
        out = []
        for line in lines:
            out.append(line)
            if 'corde' in line and 'coco' in line and 'naturel' in line and '20m' in line:
                out.append(NEW_LINE)
                inserted = True
        assert inserted, "COCO fallback insert failed — no coco 20m line found"
    return '\n'.join(out)


with psycopg2.connect(db_url) as conn:
    with conn.cursor() as cur:
        for store in ('LFC', 'COCO'):
            cur.execute(
                """
                SELECT af.id, af.content FROM agent_files af
                JOIN agents a ON a.id = af.agent_id
                WHERE a.store_code = %s AND af.name = 'prix-ht-standards.txt'
                """,
                (store,),
            )
            fid, content = cur.fetchone()
            if '3770043027001' in content:
                print(f"[{store}] déjà patché — skip")
                continue
            new_content = patch(content)
            assert '3770043027001' in new_content
            assert 'mât en bois' in new_content
            cur.execute(
                "UPDATE agent_files SET content = %s WHERE id = %s",
                (new_content, fid),
            )
            print(f"[{store}] patché : {len(content)} → {len(new_content)} chars")
    conn.commit()

print("OK — vérifie avec `psql -c \"SELECT LEFT(content, 500) FROM agent_files WHERE ...\"`")
