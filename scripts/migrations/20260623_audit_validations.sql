-- Verrou d'audit qualité par semaine ISO.
-- Quand une semaine est validée :
--   - les notes de sav_quality_audits deviennent read-only
--     (vérification applicative dans updateAuditScore)
--   - l'admin peut dévalider pour corriger
-- Garde l'historique : qui a validé quoi quand.
CREATE TABLE IF NOT EXISTS sav_audit_validations (
  id            SERIAL PRIMARY KEY,
  year          INTEGER NOT NULL,
  week_iso      INTEGER NOT NULL,
  validated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  validated_by  TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  UNIQUE (year, week_iso)
);

CREATE INDEX IF NOT EXISTS ix_audit_validations_week
  ON sav_audit_validations (year DESC, week_iso DESC);
