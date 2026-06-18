# Render Cron Job — Sync SAV nuit

Ce document explique comment configurer le cron Render qui synchronise les données Front API → BDD `sav_*` chaque nuit.

## Pré-requis

- Le repo `front-claude-app` est déjà connecté à Render
- La BDD Postgres Render existante (`DATABASE_URL`) contient les tables `sav_*`
- Token Front API valide (`FRONT_API_TOKEN`)

## Étapes Render Dashboard

### 1. Créer un nouveau service "Cron Job"

1. Ouvrir Render Dashboard → bouton **New +** en haut à droite
2. Sélectionner **Cron Job**
3. Source : choisir le repo GitHub `Rochman78/front-claude-app`, branche `main`
4. Renseigner :

| Champ | Valeur |
|---|---|
| **Name** | `sav-sync-nuit` |
| **Region** | Frankfurt (EU) — même région que ton Web service pour latence BDD |
| **Branch** | `main` |
| **Schedule** | `0 1 * * *` (3h Paris = 1h UTC, tous les jours) |
| **Build Command** | `npm install` |
| **Command** | `npx tsx scripts/sav-sync.ts` |
| **Plan** | Starter ($7/mois, suffit largement) |

> **Schedule** : `0 1 * * *` veut dire "à 01:00 UTC chaque jour". L'UTC = Paris -2h en été (juin), -1h en hiver. Pour viser 3h Paris en toutes saisons, on garde `0 1 * * *` (3h Paris été, 2h Paris hiver — toujours dans la nuit, OK).

### 2. Variables d'environnement

Onglet **Environment** du Cron Job → ajouter :

| Variable | Valeur |
|---|---|
| `DATABASE_URL` | (copier depuis le Web service Next.js — même BDD Postgres Render) |
| `FRONT_API_TOKEN` | (copier depuis le Web service) |

> Astuce : sur Render, tu peux lier des **Environment Groups** pour partager ces variables entre services au lieu de les recopier.

### 3. Première exécution manuelle

Avant de laisser le cron tourner tout seul :
1. Onglet **Manual Trigger** → cliquer **Trigger Run**
2. Aller dans **Logs** pour suivre l'exécution
3. Vérifier que tu vois :
   ```
   ═══ SAV SYNC V2 ═══
     fenêtre : 2026-XX-XXTYY:YY → ...
     mode    : 48h glissantes (cron)
   ...
   ═══ TERMINÉ en NNN s ═══
   ```

### 4. Monitoring & alertes

- Render envoie un mail automatique si le Cron Job échoue (status `failed`)
- Côté BDD, on peut auditer via :
  ```sql
  SELECT started_at, finished_at, duration_seconds, status, 
         conversations_upserted, messages_upserted, errors_count
  FROM sav_sync_log
  ORDER BY started_at DESC LIMIT 10;
  ```

## Fonctionnement du script

- Mode par défaut (sans argument) : **48h glissantes** (de `now - 48h` à `now`)
- L'overlap de 24h sécurise contre :
  - Un cron qui rate une nuit (Render down, etc.)
  - Des events Front modifiés après coup
- L'upsert est **idempotent** (ON CONFLICT DO UPDATE) → re-syncer le même intervalle ne pose aucun problème
- Toutes les exécutions sont loguées dans `sav_sync_log`

## Backfill manuel (cas exceptionnel)

Pour re-sync un intervalle spécifique (ex: rattrapage manuel) :

```bash
# En local :
npx tsx scripts/sav-sync.ts --from 2026-05-25 --to 2026-06-10

# Ou via Render Manual Trigger en ajustant temporairement le Command :
npx tsx scripts/sav-sync.ts --from 2026-05-25 --to 2026-06-10
```

## Estimation coûts/perfs

| Métrique | Valeur estimée |
|---|---|
| Durée d'un run cron 48h | 5-10 minutes |
| Volume Postgres ajouté | ~1-2 MB / jour |
| Coût Render Cron Starter | ~$7/mois |
| Total Render BDD + Web + Cron | ~$25-30/mois |

---

## Étape 2 du cron — Analyse Claude des mails inbound

L'analyse Claude Haiku 4.5 des mails inbound de la veille est **intégrée
au même cron** via `scripts/cron-sav-sync.sh` (étape 2, après la sync).
Pas de Cron Job Render séparé.

- **Script** : `scripts/analyze-yesterday.ts`
- **Output** : table `sav_message_analysis` + colonnes `demand_type`/`summary` sur `sav_conversations`
- **Consommateur** : page `/dashboard/insatisfaction` du frontapp-bi (rapport matin)

### Protection contre les erreurs

L'analyse est **non-bloquante** dans le cron :

```bash
npx tsx scripts/analyze-yesterday.ts \
  || echo "⚠️  Analyse Claude échouée — sync OK quand même."
```

Si l'API Anthropic est down ou le quota dépassé, le cron se termine quand
même en succès (la sync, la partie critique, a déjà tourné).

### Variable d'env à ajouter au Cron Job Render

| Variable | Valeur |
|---|---|
| `ANTHROPIC_API_KEY` | clé Anthropic existante (copier depuis le Web service) |

### Backfill manuel

```bash
# En local (dry-run) :
npx tsx scripts/analyze-yesterday.ts --dry-run --limit 10

# Rejouer une date spécifique :
npx tsx scripts/analyze-yesterday.ts --date 2026-06-17
```

L'INSERT est idempotent (index unique `(message_id, prompt_version)`) — relancer
le script sur la même date ne re-traite pas les mails déjà analysés.

### Coût

| Volume | Coût |
|---|---|
| ~350 mails/jour | ~$0.30/jour ≈ **$10/mois** Anthropic |

(Pas de coût Render supplémentaire puisqu'on utilise le Cron Job existant.)

### Versioning du prompt

Si on change le `SYSTEM_PROMPT` dans `analyze-yesterday.ts`, incrémenter
`PROMPT_VERSION` (`v1` → `v2`) pour permettre une ré-analyse complète sans
écraser l'historique précédent.
