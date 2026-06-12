#!/bin/bash
# Sync SAV QUOTIDIENNE — mode défaut (48h glissantes)
# À planifier sur Render Cron Job : tous les jours 04h UTC (= 06h Paris été / 05h hiver)
# Cron expression Render : 0 4 * * *
set -e
echo "═══ Cron daily SAV sync — $(date -u '+%Y-%m-%d %H:%M:%S') UTC ═══"
cd "$(dirname "$0")/.."
npx tsx scripts/sav-sync.ts
echo "═══ Daily sync terminée ═══"
