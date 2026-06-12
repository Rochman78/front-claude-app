# Setup cron SAV sync sur Render

**Un seul Cron Job** (1 facturation) qui s'adapte au jour de la semaine.

## Configuration Render Cron Job

| Champ | Valeur |
|---|---|
| Name | `sav-sync` |
| Repo | `Rochman78/front-claude-app`, branche `main` |
| Schedule (UTC) | `0 4 * * *` |
| Build Command | `npm install` |
| Command | `bash scripts/cron-sav-sync.sh` |
| Environment | `FRONT_API_TOKEN`, `DATABASE_URL` (copier depuis le service web existant) |

> Note DST : `0 4 * * *` UTC = 06h Paris en été (avr→oct), 05h Paris en hiver. Si tu veux pile 06h toute l'année, ajuste manuellement à `0 5 * * *` en hiver.

## Comportement du script

```
Lun–Sam : sync 48h glissantes      ← couvre quotidien + marge de sécurité 24h
Dimanche : sync 14 jours glissants  ← filet hebdo (rattrape events Front en retard)
```

C'est idempotent (ON CONFLICT DO UPDATE partout) : aucun doublon, juste du compute.

## Monitoring

Chaque run logue dans `sav_sync_log` :
```sql
SELECT started_at, events_seen, conversations_upserted, messages_upserted,
       errors, EXTRACT(EPOCH FROM (ended_at - started_at))::int AS duree_sec
FROM sav_sync_log
ORDER BY started_at DESC LIMIT 10;
```

Alerte recommandée : si `MAX(started_at) < NOW() - INTERVAL '25 hours'` → la sync n'a pas tourné.

## Backfill manuel

Pour rejouer une période :
```bash
npx tsx scripts/sav-sync.ts --from 2026-XX-XX --to 2026-XX-XX
```
