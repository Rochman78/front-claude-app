#!/bin/bash
# Sync SAV unique — exécuté tous les jours à 06h Paris.
#   - Du Lun au Sam : sync 48h glissantes (mode défaut)
#   - Le Dimanche   : sync 14 jours glissants (filet de sécurité)
# Render Cron Job : 0 4 * * * (UTC, = 06h Paris été)
set -e
cd "$(dirname "$0")/.."

DAY=$(date -u +%u)  # 1=Lun … 7=Dim
echo "═══ Cron SAV sync — $(date -u '+%Y-%m-%d %H:%M:%S') UTC (jour $DAY) ═══"

if [ "$DAY" = "7" ]; then
  # Dimanche : filet de sécurité 14 jours
  FROM=$(date -u -d '14 days ago' '+%Y-%m-%d')
  TO=$(date -u '+%Y-%m-%d')
  echo "Dimanche → filet 14j : $FROM → $TO"
  npx tsx scripts/sav-sync.ts --from "$FROM" --to "$TO"
else
  # Lun-Sam : 48h glissantes
  echo "Mode défaut : 48h glissantes"
  npx tsx scripts/sav-sync.ts
fi

echo "═══ Sync terminée ═══"
