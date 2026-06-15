# Mise à jour des prix catalogue (prix-ht-standards.txt × 10 boutiques)

## Quand l'utiliser

À chaque mise à jour des prix TTC du catalogue LFC (la boutique LFC est l'**autorité TTC** — toutes les boutiques reprennent les mêmes TTC, seul le HT change selon la TVA pays).

## Comment

1. Charles exporte le catalogue LFC depuis Shopify au format CSV avec les colonnes :
   `sku, product_title, variant_title, price_eur, inventory_qty, barcode, product_id`
2. Sauvegarder le fichier sous `/Users/charlesbamy/Desktop/LFC_catalogue.csv`
3. Lancer le script en dry-run pour vérifier les changements :

```bash
export DATABASE_URL=$(grep DATABASE_URL /Users/charlesbamy/front-claude-app/.env | cut -d= -f2-)
cd /Users/charlesbamy/front-claude-app
python3 scripts/catalogue/regen_prix_ht_standards.py dry
```

4. Si OK, appliquer (un backup automatique des fichiers actuels est créé dans `backups/prix-ht-standards-<timestamp>/`) :

```bash
# Backup manuel d'abord (recommandé)
TS=$(date -u +%Y%m%d-%H%M%S)
mkdir -p backups/prix-ht-standards-$TS
python3 -c "
import os, psycopg2
DATABASE_URL = os.environ['DATABASE_URL']
out = 'backups/prix-ht-standards-$TS'
with psycopg2.connect(DATABASE_URL) as conn, conn.cursor() as cur:
    cur.execute(\"SELECT a.store_code, af.content FROM agent_files af JOIN agents a ON a.id=af.agent_id WHERE af.name='prix-ht-standards.txt' ORDER BY a.store_code\")
    for code, content in cur.fetchall():
        open(f'{out}/prix-ht-{code}.txt', 'w').write(content)
"

# Apply
python3 scripts/catalogue/regen_prix_ht_standards.py apply
```

## Règles métier

- **TTC identique pour les 10 boutiques** : LFC, LVO, COCO, MON, UNI, TAR, HET, RED, REDE, RETE
- **HT recalculé par taux TVA** : 0 % (LIC/export = TTC), 17 %, 18 %, 19 %, 20 %, 21 %, 22 %, 23 %, 24 %, 25 %, 25,5 %, 27 %
- Formule : `HT = TTC / (1 + TVA/100)` arrondi à 2 décimales
- **SKU absent du CSV → ligne intacte** (le script ne supprime rien et n'ajoute rien — il met juste à jour les prix sur les lignes existantes)
- **Stock NON intégré** : le stock live est lu via API Octopia, pas via les fichiers agent
- **Hors périmètre** : la grille `prix-ht-sur-mesure.txt` (HT/m² par forme × finition × tranche surface) reste 100 % manuelle, ce n'est pas dans Shopify
