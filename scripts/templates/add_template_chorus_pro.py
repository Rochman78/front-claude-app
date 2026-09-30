#!/usr/bin/env python3
"""
Ajoute le template « Chorus Pro — demande bon de commande » (toutes boutiques,
store_code = 'all'). Charles 30/09/2026.

Cas : commande d'une entité publique, la facture doit être déposée sur
Chorus Pro → on demande SIRET, n° d'engagement juridique / bon de commande,
code service, contact service facturier.

Idempotent : id fixe `tpl_chorus_pro_bon_commande`, UPSERT (relancer met à
jour le texte). Backup de la table templates avant écriture dans
backups/template-chorus-pro-<timestamp>/templates_backup.json.

Usage : python3 scripts/templates/add_template_chorus_pro.py
"""
import json
import os
import sys
from datetime import datetime, timezone

import psycopg2

TEMPLATE_ID = "tpl_chorus_pro_bon_commande"
NAME = "Chorus Pro — demande bon de commande"
SUMMARY = (
    "À utiliser quand une entité publique (mairie, collectivité, école, EHPAD "
    "public, administration…) passe commande : la facture doit être déposée "
    "sur Chorus Pro. Demande SIRET, n° d'engagement juridique / bon de "
    "commande, code service et contact du service facturier."
)
CONTENT = """Bonjour,

Nous vous remercions pour votre commande.

S'agissant d'une entité publique, notre facture doit obligatoirement vous être transmise via la plateforme Chorus Pro. Afin que celle-ci soit correctement acheminée et mise en paiement, pourriez-vous nous communiquer les informations suivantes :
• le SIRET de l'entité destinataire de la facture ;
• le numéro d'engagement juridique (ou numéro de bon de commande) ;
• le code service (code exécutant) auquel adresser la facture ;
• le cas échéant, les coordonnées de votre service facturier / gestionnaire.

Ces éléments sont indispensables au dépôt de la facture ; sans eux, celle-ci ne peut malheureusement pas être traitée par vos services.

Dès réception de ces informations, nous finaliserons le traitement de votre commande dans les meilleurs délais."""


def main():
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        sys.exit("DATABASE_URL manquant")
    conn = psycopg2.connect(db_url)
    cur = conn.cursor()

    cur.execute("SELECT id, name, summary, content, store_code, created_at, "
                "attachment_url, procedure_url FROM templates ORDER BY id")
    cols = [d[0] for d in cur.description]
    rows = [dict(zip(cols, r)) for r in cur.fetchall()]

    existing = next((r for r in rows if r["id"] == TEMPLATE_ID), None)
    if existing and existing["name"] == NAME and existing["summary"] == SUMMARY \
            and existing["content"] == CONTENT:
        print("Template déjà à jour, rien à faire.")
        return

    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_dir = os.path.join("backups", f"template-chorus-pro-{ts}")
    os.makedirs(backup_dir, exist_ok=True)
    with open(os.path.join(backup_dir, "templates_backup.json"), "w") as f:
        json.dump(rows, f, ensure_ascii=False, indent=2)
    print(f"Backup : {backup_dir}/templates_backup.json ({len(rows)} templates)")

    cur.execute(
        """INSERT INTO templates (id, name, summary, content, store_code, created_at,
                                  attachment_url, procedure_url)
           VALUES (%s, %s, %s, %s, 'all', %s, '', '')
           ON CONFLICT (id) DO UPDATE
             SET name = EXCLUDED.name, summary = EXCLUDED.summary,
                 content = EXCLUDED.content""",
        (TEMPLATE_ID, NAME, SUMMARY, CONTENT,
         datetime.now(timezone.utc).isoformat()),
    )
    conn.commit()
    print("Mis à jour." if existing else "Template ajouté (toutes boutiques).")


if __name__ == "__main__":
    main()
