#!/usr/bin/env python3
"""
Patch agents.instructions pour LFC et COCO :
- Ajoute mention "mât en bois" à la liste initiale des accessoires
- Ajoute la ligne "Mât en bois Robinier (SPARS design) .... SKU 3770043027001" sous MÂT & FIXATION SOL
- Ajoute "mât en bois" à la liste de FORMES accessoires (RÈGLE STRICT 5 CRITÈRES)
- Ajoute un PIÈGE OBSERVÉ sur la confusion mât télescopique / mât en bois

Idempotent : ne double-patch pas si "3770043027001" est déjà dans le texte.
"""
import psycopg2

env_path = '/Users/charlesbamy/front-claude-app/.env'
with open(env_path) as f:
    for line in f:
        if line.startswith('DATABASE_URL='):
            db_url = line.split('=', 1)[1].strip()
            break

# 1) Enrichir la liste initiale des accessoires
OLD_ACCESSORY_LIST = (
    "Quand tu mentionnes un ACCESSOIRE dans un brouillon "
    "(mât, base d'ancrage, kit de fixation, cordes à cliquets, câble acier au mètre, "
    "corde polyester tressée, corde fibre de coco, colliers de serrage, borne solaire, échantillon)"
)
NEW_ACCESSORY_LIST = (
    "Quand tu mentionnes un ACCESSOIRE dans un brouillon "
    "(mât télescopique, mât en bois Robinier, base d'ancrage, kit de fixation, cordes à cliquets, "
    "câble acier au mètre, corde polyester tressée, corde fibre de coco, colliers de serrage, "
    "borne solaire, échantillon)"
)

# 2) Sous MÂT & FIXATION SOL — insérer la ligne mât bois après mât télescopique
OLD_MAT_BLOCK = """  MÂT & FIXATION SOL
    - Mât télescopique aluminium ............. SKU 3760263850060
    - Base d'ancrage aluminium ............... SKU 3760263850015
    - Borne solaire .......................... SKU 3760263850053"""
NEW_MAT_BLOCK = """  MÂT & FIXATION SOL
    - Mât télescopique aluminium ............. SKU 3760263850060
    - Mât en bois Robinier (SPARS design) .... SKU 3770043027001
    - Base d'ancrage aluminium ............... SKU 3760263850015
    - Borne solaire .......................... SKU 3760263850053"""

# 3) Liste des formes accessoires (règle 5 critères)
OLD_FORMES = "+ `corde` | `cable` | `rislan` | `mât télescopique` | `base ancrage` | `kit de fixation` | `corde à cliquets` | `borne solaire` (accessoires)"
NEW_FORMES = "+ `corde` | `cable` | `rislan` | `mât télescopique` | `mât en bois` | `base ancrage` | `kit de fixation` | `corde à cliquets` | `borne solaire` (accessoires)"

# 4) Piège : ne pas confondre les 2 mâts. On l'ajoute à la fin du bloc PIÈGES OBSERVÉS.
OLD_PIEGES_END = "Confondre « Câble acier au mètre » (bobines accessoires, voile d'ombrage) avec le « contour câble acier inox Ø 3 mm » (qui fait partie du filet, soudé au bord)."
NEW_PIEGES_END = OLD_PIEGES_END + """
- Confondre « Mât télescopique aluminium » (SKU 3760263850060, tube alu, colis standard, 189,99 € TTC) avec « Mât en bois Robinier » (SKU 3770043027001, bois massif, scellement béton obligatoire, livraison C Chez vous avec RDV, 219,99 € TTC). Ce sont 2 produits distincts — toujours confirmer avec le client lequel il souhaite si ce n'est pas explicite. Fiche technique complète : FT-Mat-Bois-Robinier.txt."""


def patch(text: str) -> str:
    assert OLD_ACCESSORY_LIST in text, "OLD_ACCESSORY_LIST introuvable"
    assert OLD_MAT_BLOCK in text, "OLD_MAT_BLOCK introuvable"
    assert OLD_FORMES in text, "OLD_FORMES introuvable"
    assert OLD_PIEGES_END in text, "OLD_PIEGES_END introuvable"
    text = text.replace(OLD_ACCESSORY_LIST, NEW_ACCESSORY_LIST, 1)
    text = text.replace(OLD_MAT_BLOCK, NEW_MAT_BLOCK, 1)
    text = text.replace(OLD_FORMES, NEW_FORMES, 1)
    text = text.replace(OLD_PIEGES_END, NEW_PIEGES_END, 1)
    return text


with psycopg2.connect(db_url) as conn:
    with conn.cursor() as cur:
        for store in ('LFC', 'COCO'):
            cur.execute("SELECT id, instructions FROM agents WHERE store_code = %s", (store,))
            aid, instr = cur.fetchone()
            if '3770043027001' in instr:
                print(f"[{store}] déjà patché — skip")
                continue
            new = patch(instr)
            assert '3770043027001' in new
            assert 'mât en bois' in new.lower()
            cur.execute("UPDATE agents SET instructions = %s WHERE id = %s", (new, aid))
            print(f"[{store}] patché : {len(instr)} → {len(new)} chars")
    conn.commit()
print("OK")
