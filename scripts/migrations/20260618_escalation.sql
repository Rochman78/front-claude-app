-- Ajoute la dimension "gravité business" à l'analyse Claude.
-- Distincte du sentiment (ton du message). Un client poli qui annonce un
-- chargeback = escalation_level='critique' même si sentiment='neutre'.
ALTER TABLE sav_message_analysis
  ADD COLUMN IF NOT EXISTS escalation_level TEXT
    CHECK (escalation_level IN ('aucun','surveiller','critique')) DEFAULT 'aucun',
  ADD COLUMN IF NOT EXISTS escalation_reasons TEXT[] DEFAULT '{}';

CREATE INDEX IF NOT EXISTS ix_analysis_escalation
  ON sav_message_analysis (escalation_level, analyzed_at DESC)
  WHERE escalation_level <> 'aucun';
