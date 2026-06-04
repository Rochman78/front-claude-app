#!/usr/bin/env python3
"""
Fix règle paiement sur-mesure sur les 9 boutiques :
- Qualifie la ligne "Paiement : CB, PayPal..." pour préciser que c'est UNIQUEMENT
  pour les commandes standard en ligne (pas pour les devis).
- Renforce la règle RÈGLEMENT pour expliquer clairement quoi faire quand le
  client demande explicitement le RIB ou le mode de paiement.

Cas Sophie BESNARD (cnv_1lhinjiv, 04/06/2026) : Claude avait proposé
"CB, PayPal, 3x Klarna" pour un devis sur-mesure → erreur.
"""
import re, subprocess
from pathlib import Path

DATABASE_URL = subprocess.check_output(
    "grep DATABASE_URL /Users/charlesbamy/front-claude-app/.env | cut -d= -f2-",
    shell=True
).decode().strip()

STORES = ["LFC", "LVO", "MON", "UNI", "TAR", "HET", "RED", "RETE", "COCO"]

# Anciennes lignes (chaque boutique a EXACTEMENT ces textes)
OLD_PAYMENT_LINE = "- Paiement : CB, PayPal, Apple Pay, Klarna (3x sans frais)"
NEW_PAYMENT_LINE = (
    "- Paiement : CB, PayPal, Apple Pay, Klarna (3x sans frais) "
    "— ⚠️ UNIQUEMENT pour les commandes STANDARD passées en ligne. "
    "Pour tout devis (PDF Pennylane, sur-mesure ou grosse quantité) : "
    "VIREMENT BANCAIRE UNIQUEMENT, RIB transmis séparément par le gérant."
)

OLD_RULE = "- RÈGLEMENT : NE JAMAIS mentionner le mode de paiement ni le virement bancaire dans le brouillon de chiffrage. Le règlement est géré automatiquement dans le mail d'accompagnement du devis PDF. JAMAIS de CB/PayPal/Klarna."
NEW_RULE = (
    "- RÈGLEMENT (DEVIS / SUR-MESURE) : pour tout devis (PDF Pennylane), "
    "le paiement est OBLIGATOIREMENT par VIREMENT BANCAIRE. "
    "JAMAIS de CB / PayPal / Klarna / Apple Pay / 3x sans frais sur un devis "
    "(ces moyens existent UNIQUEMENT pour les commandes standard en ligne sur le site). "
    "Comportement attendu : "
    "(a) par DÉFAUT, ne PAS mentionner le mode de paiement dans le chiffrage — "
    "le règlement est géré dans le mail d'accompagnement du devis PDF. "
    "(b) Si le client DEMANDE EXPLICITEMENT le RIB ou le mode de paiement, "
    "répondre une phrase courte : « Le règlement s'effectue par virement bancaire "
    "à réception du devis validé. Nous vous transmettrons le RIB séparément. » "
    "puis FLAGGER en QUESTIONS pour que le gérant envoie le RIB. "
    "INTERDIT : inventer un IBAN, proposer CB/Klarna/PayPal pour un devis, "
    "même sur insistance du client (sauf instruction formelle du gérant)."
)

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
    new = content
    n_payment = new.count(OLD_PAYMENT_LINE)
    n_rule = new.count(OLD_RULE)
    new = new.replace(OLD_PAYMENT_LINE, NEW_PAYMENT_LINE)
    new = new.replace(OLD_RULE, NEW_RULE)
    return new, n_payment, n_rule

def main():
    for store in STORES:
        print(f"━━━ {store} ━━━")
        cur = get_instructions(store)
        if not cur:
            print(f"  ⚠️  no instructions — skip")
            continue
        new, np, nr = patch(cur)
        if np == 0 and nr == 0:
            print(f"  ⚠️  aucune des deux lignes trouvée — skip")
            continue
        delta = len(new) - len(cur)
        print(f"  payment-line: {np}× | rule-line: {nr}× | Δ taille = {delta:+d} octets")
        update_instructions(store, new)
        # Sanity
        re_check = get_instructions(store)
        if "VIREMENT BANCAIRE UNIQUEMENT" in re_check and "RÈGLEMENT (DEVIS / SUR-MESURE)" in re_check:
            print(f"  ✅ {store} mis à jour ({len(re_check)} octets)")
        else:
            print(f"  ❌ {store} : vérification échouée !")
        print()

if __name__ == "__main__":
    main()
