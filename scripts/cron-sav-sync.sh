#!/bin/bash
# Cron quotidien (06h Paris) — 2 étapes séquentielles :
#   1) Sync SAV Front → BDD (CRITIQUE — filet de sécurité du webhook)
#        - Lun-Sam : sync 48h glissantes (mode défaut)
#        - Dimanche : sync 14 jours glissants
#   2) Analyse Claude des mails inbound de la veille (BONUS — feed le
#      dashboard /dashboard/insatisfaction du frontapp-bi)
#
# La sync est protégée par `set -e` : si elle échoue, on s'arrête sans
# lancer l'analyse (pas de données fraîches → analyse stale).
# L'analyse est protégée par `|| echo` : si elle échoue, le cron se termine
# en succès quand même (la sync, la partie critique, a réussi).
#
# Render Cron Job : 0 4 * * * (UTC, = 06h Paris été)
set -e
cd "$(dirname "$0")/.."

DAY=$(date -u +%u)  # 1=Lun … 7=Dim
echo "═══ Cron SAV sync — $(date -u '+%Y-%m-%d %H:%M:%S') UTC (jour $DAY) ═══"

# ─── Étape 1 : sync Front → BDD ──────────────────────────────────
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

# ─── Étape 2 : analyse Claude (bonus, non-bloquante) ─────────────
echo "═══ Analyse mails veille — $(date -u '+%Y-%m-%d %H:%M:%S') UTC ═══"
npx tsx scripts/analyze-yesterday.ts \
  || echo "⚠️  Analyse Claude échouée — sync OK quand même (cron en succès)."

echo "═══ Cron terminé — $(date -u '+%Y-%m-%d %H:%M:%S') UTC ═══"
