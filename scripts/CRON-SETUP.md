# Setup cron SAV sync sur Render

Deux Cron Jobs à créer sur Render pour garantir zéro perte d'event Front App.

## 1. Sync quotidienne (06h00 Paris)

**Pourquoi** : couvre le quotidien avec 24h de marge de sécurité (fenêtre 48h glissantes par défaut).

| Champ | Valeur |
|---|---|
| Name | `sav-sync-daily` |
| Schedule (UTC) | `0 4 * * *` |
| Build Command | `npm install` |
| Command | `bash scripts/cron-sav-sync-daily.sh` |
| Environment | Same as web service (FRONT_API_TOKEN, DATABASE_URL) |

> Le `0 4 * * *` UTC = 06h00 Paris en été, 05h00 en hiver (DST). Si tu veux strictement 06h00 toute l'année, change manuellement à `0 5 * * *` en hiver.

## 2. Sync hebdo "filet de sécurité" (Dimanche 22h00 Paris)

**Pourquoi** : rattrape les events Front qui auraient été publiés en retard (rare mais possible). Fenêtre 14 jours glissants. Idempotent, zéro doublon.

| Champ | Valeur |
|---|---|
| Name | `sav-sync-weekly-filet` |
| Schedule (UTC) | `0 20 * * 0` |
| Build Command | `npm install` |
| Command | `bash scripts/cron-sav-sync-weekly.sh` |
| Environment | Same as web service (FRONT_API_TOKEN, DATABASE_URL) |

## Variables d'environnement requises

- `FRONT_API_TOKEN` : token API Front App (lecture)
- `DATABASE_URL` : connection string PostgreSQL Render

## Monitoring

Chaque run enregistre des stats dans la table `sav_sync_log` (events vus, conversations upsertées, messages, erreurs, durée).

Pour surveiller :
```sql
SELECT started_at, ended_at, events_seen, conversations_upserted,
       messages_upserted, errors,
       EXTRACT(EPOCH FROM (ended_at - started_at))::int AS duree_sec
FROM sav_sync_log
ORDER BY started_at DESC LIMIT 20;
```

Alerte recommandée : si `MAX(started_at) < NOW() - INTERVAL '25 hours'` → la sync n'a pas tourné depuis hier.

## Backfill manuel

Pour rejouer une période en cas de besoin :
```bash
npx tsx scripts/sav-sync.ts --from 2026-XX-XX --to 2026-XX-XX
```
