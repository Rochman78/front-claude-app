# Batch mail — Doublon expédition (03/07/2026)

Envoi d'un même mail à 143 clients depuis Front App, traduit dans la langue de leur boutique.

Fichier source : `/Users/charlesbamy/Downloads/DOUBLON OCTOPIA - avec emails.xlsx` (2 colonnes : `mother_order` + `client_email`).

Répartition (préfixes de commande) :
- **LFC** 78 (FR) — Le Filet de Camouflage
- **COCO** 19 (FR) — Ma Toile Coco
- **HC** 17 (NL) — Het Camouflagenet
- **RDC** 12 (ES) — Red de Camuflaje
- **TZ** 11 (DE) — Tarnnetz
- **LVO** 4 (FR) — Le Voile d'Ombrage
- **RM** 1 (IT) — Rete Mimetica
- **UC** 1 (FR) — Univers Camouflage

## Flow global

```
1. translate_once.py    → génère translations.json (FR/DE/NL/ES/IT)
2. create_drafts.py     → crée 143 brouillons dans Front + log.csv
3. Charles relit dans Front   ↓
                          - supprime les drafts qu'il ne veut PAS envoyer
                          - édite ceux qu'il veut modifier
4. send_drafts.py       → envoie tous les drafts restants + send_log.csv
```

## Prérequis

- Python 3 + `pip install --break-system-packages anthropic openpyxl`
- `.env` avec `ANTHROPIC_API_KEY` et `FRONT_API_TOKEN` à la racine du repo

## Utilisation

### 1. Générer les traductions (une seule fois)

```bash
python3 scripts/batch-mail/translate_once.py
```

Traduit le mail FR vers DE / NL / ES / IT via Sonnet. Sauve dans `translations.json`. À valider par Charles avant l'étape suivante.

### 2. Créer les 143 brouillons

**Dry-run recommandé d'abord** :

```bash
python3 scripts/batch-mail/create_drafts.py --dry-run --limit 5
```

Affiche ce que le script ferait pour les 5 premières lignes, sans appeler Front.

**Vrai run — test 1 draft** :

```bash
python3 scripts/batch-mail/create_drafts.py --limit 1
```

Crée 1 seul draft. Charles va vérifier dans Front que le rendu est OK (destinataire, sujet, corps, langue, expéditeur = bonne boutique).

**Vrai run — batch complet** :

```bash
python3 scripts/batch-mail/create_drafts.py
```

Idempotent : re-run reprend là où ça s'est arrêté (skip des entrées déjà loggées `status=ok` dans `log.csv`).

**Rate-limit** : ~5 req/s, ~30 s total pour 143. Retries auto sur 429/5xx.

### 3. Charles relit dans Front

Ouvre chaque inbox concernée dans Front, filtre sur les brouillons (créés par le token API).

- Un draft **à ne PAS envoyer** → clic **Delete** sur ce draft dans Front. Il sera skippé par send_drafts.
- Un draft **à modifier** → clic **Edit**, modifie, sauve.

### 4. Envoyer tout ce qui reste

**Dry-run** :

```bash
python3 scripts/batch-mail/send_drafts.py --dry-run
```

**Envoi test — 1 draft** :

```bash
python3 scripts/batch-mail/send_drafts.py --limit 1
```

**Envoi complet** :

```bash
python3 scripts/batch-mail/send_drafts.py
```

Pour chaque draft du `log.csv` :
1. `GET /drafts/{draft_id}` → 404 = supprimé par Charles → skip
2. Sinon lit le contenu ACTUEL (édits Charles pris en compte)
3. `POST /channels/{ch}/messages` avec ce contenu → envoi direct au client
4. `DELETE /drafts/{draft_id}` → cleanup

Résultat dans `send_log.csv` (status = `sent` | `skip-deleted` | `error`).

## Files

- `translate_once.py` : one-shot traduction (Sonnet)
- `translations.json` : templates finaux (regénérables)
- `config.py` : mappings préfixe → store + channel_id
- `create_drafts.py` : Script A
- `send_drafts.py` : Script B
- `log.csv` : output Script A / input Script B (git-ignored)
- `send_log.csv` : output Script B (git-ignored)

## Sécurités

- **Retry auto** sur 429/5xx (backoff 1s → 2s → 4s)
- **Idempotence** : rerun de A ou B ne double pas les drafts / envois
- **Dry-run** dispo sur les 2 scripts
- **Limit** dispo pour tester sur 1-5 lignes avant de lâcher les 143

## En cas de merde

- **Un mail est parti au mauvais client** : Front, ouvrir la conv, envoyer un mail de rectification. Impossible d'annuler un send.
- **Un draft n'est pas créé** : voir la colonne `error` dans `log.csv`. Rerun `create_drafts.py` — les OK sont skippés, seuls les KO sont retentés.
- **Le script plante mid-run** : rerun. L'idempotence reprend là où ça s'est arrêté.
