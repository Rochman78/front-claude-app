#!/bin/bash
# Sync SAV HEBDO "filet de sécurité" — fenêtre 14 jours glissants
# À planifier sur Render Cron Job : tous les dimanches 20h UTC (= 22h Paris été / 21h hiver)
# Cron expression Render : 0 20 * * 0
# Sécurise les events qui auraient été manqués par la sync daily.
set -e
echo "═══ Cron weekly SAV sync filet — $(date -u '+%Y-%m-%d %H:%M:%S') UTC ═══"
cd "$(dirname "$0")/.."
FROM=$(date -u -d '14 days ago' '+%Y-%m-%d')
TO=$(date -u '+%Y-%m-%d')
echo "Fenêtre : $FROM → $TO"
npx tsx scripts/sav-sync.ts --from "$FROM" --to "$TO"
echo "═══ Weekly sync terminée ═══"
