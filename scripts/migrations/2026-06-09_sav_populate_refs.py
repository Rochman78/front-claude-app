#!/usr/bin/env python3
"""
Peuple les 5 tables référentielles du schéma SAV :
- sav_inboxes     : depuis Front API /inboxes (10 boîtes boutiques)
- sav_teammates   : depuis Front API /teammates + données métier (horaires, contrat)
- sav_tags        : depuis Front API /tags
- sav_channels    : depuis Front API /channels
- sav_holidays    : codé en dur (jours fériés FR 2026 + 2027)

Idempotent : ON CONFLICT (id) DO UPDATE. Peut être rejoué.
"""
import json, os, subprocess, urllib.request, urllib.error
from pathlib import Path

ENV_PATH = "/Users/charlesbamy/front-claude-app/.env"
DATABASE_URL = subprocess.check_output(f"grep '^DATABASE_URL=' {ENV_PATH} | cut -d= -f2-", shell=True).decode().strip()
FRONT_TOKEN  = subprocess.check_output(f"grep '^FRONT_API_TOKEN=' {ENV_PATH} | cut -d= -f2-", shell=True).decode().strip()

FRONT_API = "https://api2.frontapp.com"

# Mapping store_code par nom d'inbox (ordre stable, basé sur connaissance projet)
INBOX_STORE_CODE = {
    "Le Filet de Camouflage":  "LFC",
    "Ma Toile Coco":           "COCO",
    "Het Camouflagenet":       "HET",
    "Le Voile d'Ombrage":      "LVO",
    "Red de Camuflaje":        "RED",
    "Tarnnetz":                "TAR",
    "L'Univers du Camouflage": "UNI",
    "Rete Mimetica":           "RETE",
    "The Camouflage Net":      "EN",
    "Mon Ombrage":             "MON",
}

# Données métier teammates (horaires, contrat, admin)
TEAMMATE_OVERRIDES = {
    # Salariées Madagascar — 7h/j sauf mardi 6h = 27h sur Lun-Ven (lun férié → 27 - 7 = 20h cette semaine)
    "tea_hmfvb": {"name": "Murella Z.",   "role": "Service Client",         "is_admin": False, "weekly_hours": 33, "contract_type": "salarié"},
    "tea_mxhsn": {"name": "Roniah R.",    "role": "Service Client",         "is_admin": False, "weekly_hours": 33, "contract_type": "salarié"},
    "tea_mxqqf": {"name": "Jérémy LERAT", "role": "Responsable Service Client", "is_admin": True,  "weekly_hours": 0,  "contract_type": "admin"},
    "tea_gnazb": {"name": "Charles BAMY", "role": "Fondateur Zephyr OSC",   "is_admin": True,  "weekly_hours": 0,  "contract_type": "admin"},
}

# Jours fériés FR 2026 + 2027 (source : service-public.fr, dates fixes + Pâques calculée)
HOLIDAYS = [
    # 2026
    ("2026-01-01", "Jour de l'An"),
    ("2026-04-06", "Lundi de Pâques"),
    ("2026-05-01", "Fête du Travail"),
    ("2026-05-08", "Victoire 1945"),
    ("2026-05-14", "Ascension"),
    ("2026-05-25", "Lundi de Pentecôte"),
    ("2026-07-14", "Fête nationale"),
    ("2026-08-15", "Assomption"),
    ("2026-11-01", "Toussaint"),
    ("2026-11-11", "Armistice 1918"),
    ("2026-12-25", "Noël"),
    # 2027
    ("2027-01-01", "Jour de l'An"),
    ("2027-03-29", "Lundi de Pâques"),
    ("2027-05-01", "Fête du Travail"),
    ("2027-05-06", "Ascension"),
    ("2027-05-08", "Victoire 1945"),
    ("2027-05-17", "Lundi de Pentecôte"),
    ("2027-07-14", "Fête nationale"),
    ("2027-08-15", "Assomption"),
    ("2027-11-01", "Toussaint"),
    ("2027-11-11", "Armistice 1918"),
    ("2027-12-25", "Noël"),
]

def front_get_all(endpoint):
    """Pagine via _pagination.next jusqu'à épuisement."""
    items, url = [], f"{FRONT_API}{endpoint}"
    while url:
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {FRONT_TOKEN}", "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as r:
            d = json.loads(r.read().decode())
        items.extend(d.get("_results", []))
        url = d.get("_pagination", {}).get("next")
    return items

def psql(sql, params=None):
    """Exécute via psql en pipe pour gérer les caractères spéciaux. Pour upsert simples on utilise -c."""
    return subprocess.check_output(["psql", DATABASE_URL, "-At", "-c", sql], text=True)

def psql_exec(sql_with_values):
    """Exécute du SQL multi-statement via stdin (plus safe pour les strings avec quotes)."""
    subprocess.run(["psql", DATABASE_URL], input=sql_with_values, text=True, check=True, capture_output=True)

def esc(s):
    """Échappe une string pour SQL inline."""
    if s is None:
        return "NULL"
    return "'" + str(s).replace("'", "''") + "'"

# ─── 1. INBOXES ──────────────────────────────────────────────
def populate_inboxes():
    print("━━━ sav_inboxes ━━━")
    items = front_get_all("/inboxes?limit=100")
    print(f"  Front API : {len(items)} inboxes total")
    sql_lines = []
    n = 0
    for it in items:
        iid = it.get("id")
        name = it.get("name") or ""
        itype = it.get("type") or ""
        store = INBOX_STORE_CODE.get(name)
        if not store:
            continue  # On ne garde que les boutiques connues
        sql_lines.append(
            f"INSERT INTO sav_inboxes (id, store_code, name, type) "
            f"VALUES ({esc(iid)}, {esc(store)}, {esc(name)}, {esc(itype)}) "
            f"ON CONFLICT (id) DO UPDATE SET store_code=EXCLUDED.store_code, name=EXCLUDED.name, type=EXCLUDED.type;"
        )
        n += 1
    psql_exec("\n".join(sql_lines))
    print(f"  ✅ {n} inboxes (boutiques) upsertées")

# ─── 2. TEAMMATES ────────────────────────────────────────────
def populate_teammates():
    print("━━━ sav_teammates ━━━")
    items = front_get_all("/teammates?limit=100")
    print(f"  Front API : {len(items)} teammates")
    sql_lines = []
    n = 0
    for it in items:
        tid = it.get("id")
        email = it.get("email") or ""
        first = it.get("first_name") or ""
        last  = it.get("last_name") or ""
        default_name = f"{first} {last}".strip() or email
        override = TEAMMATE_OVERRIDES.get(tid, {})
        name = override.get("name", default_name)
        role = override.get("role", "")
        is_admin = override.get("is_admin", False)
        weekly_hours = override.get("weekly_hours", 0)
        contract = override.get("contract_type", "")
        sql_lines.append(
            f"INSERT INTO sav_teammates (id, email, name, role, is_admin, weekly_hours, contract_type) "
            f"VALUES ({esc(tid)}, {esc(email)}, {esc(name)}, {esc(role)}, {is_admin}, {weekly_hours}, {esc(contract)}) "
            f"ON CONFLICT (id) DO UPDATE SET email=EXCLUDED.email, name=EXCLUDED.name, role=EXCLUDED.role, "
            f"is_admin=EXCLUDED.is_admin, weekly_hours=EXCLUDED.weekly_hours, contract_type=EXCLUDED.contract_type;"
        )
        n += 1
    psql_exec("\n".join(sql_lines))
    print(f"  ✅ {n} teammates upsertés")

# ─── 3. TAGS ──────────────────────────────────────────────────
def populate_tags():
    print("━━━ sav_tags ━━━")
    items = front_get_all("/tags?limit=100")
    print(f"  Front API : {len(items)} tags")
    sql_lines = []
    n = 0
    for it in items:
        tid = it.get("id")
        name = it.get("name") or ""
        color = it.get("highlight") or ""  # Front renvoie "highlight" pour la couleur
        # Catégorisation simple par mot-clé
        lname = name.lower()
        if any(k in lname for k in ["devis", "quote", "estimate"]):
            category = "devis"
        elif any(k in lname for k in ["bruit", "spam", "newsletter"]):
            category = "bruit"
        elif any(k in lname for k in ["annul", "cancel", "retour", "rembours"]):
            category = "sav"
        else:
            category = "autre"
        sql_lines.append(
            f"INSERT INTO sav_tags (id, name, color, category) "
            f"VALUES ({esc(tid)}, {esc(name)}, {esc(color)}, {esc(category)}) "
            f"ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, color=EXCLUDED.color, category=EXCLUDED.category;"
        )
        n += 1
    psql_exec("\n".join(sql_lines))
    print(f"  ✅ {n} tags upsertés")

# ─── 4. CHANNELS ──────────────────────────────────────────────
def populate_channels():
    print("━━━ sav_channels ━━━")
    items = front_get_all("/channels?limit=100")
    print(f"  Front API : {len(items)} channels")
    sql_lines = []
    n = 0
    for it in items:
        cid = it.get("id")
        ctype = it.get("type") or ""
        cname = it.get("name") or ""
        # Récupérer l'inbox parent depuis _links si dispo
        inbox_link = (it.get("_links") or {}).get("related", {}).get("inbox", "")
        inbox_id = ""
        if inbox_link:
            inbox_id = inbox_link.rstrip("/").split("/")[-1]
        sql_lines.append(
            f"INSERT INTO sav_channels (id, inbox_id, type, name) "
            f"VALUES ({esc(cid)}, {esc(inbox_id) if inbox_id else 'NULL'}, {esc(ctype)}, {esc(cname)}) "
            f"ON CONFLICT (id) DO UPDATE SET inbox_id=EXCLUDED.inbox_id, type=EXCLUDED.type, name=EXCLUDED.name;"
        )
        n += 1
    psql_exec("\n".join(sql_lines))
    print(f"  ✅ {n} channels upsertés")

# ─── 5. HOLIDAYS ──────────────────────────────────────────────
def populate_holidays():
    print("━━━ sav_holidays ━━━")
    sql_lines = []
    for date_str, name in HOLIDAYS:
        sql_lines.append(
            f"INSERT INTO sav_holidays (date, name) VALUES ({esc(date_str)}, {esc(name)}) "
            f"ON CONFLICT (date) DO UPDATE SET name=EXCLUDED.name;"
        )
    psql_exec("\n".join(sql_lines))
    print(f"  ✅ {len(HOLIDAYS)} jours fériés FR 2026+2027 upsertés")

# ─── MAIN ──────────────────────────────────────────────────────
def main():
    print("═══ Peuplement référentiels SAV ═══\n")
    populate_inboxes()
    populate_teammates()
    populate_tags()
    populate_channels()
    populate_holidays()
    print("\n═══ FIN ═══")

if __name__ == "__main__":
    main()
