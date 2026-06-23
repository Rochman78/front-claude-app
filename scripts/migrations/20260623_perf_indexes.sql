-- Index de performance pour le dashboard (queries entrants / agents).
-- Mesures avant : fetchEntrants 14j = 4.0s (seq scan sur 35k messages).
-- Cible après : < 500ms.
--
-- Index composé qui couvre les sub-queries du type
--   COUNT(*) WHERE direction='in' AND is_draft=false AND created_at BETWEEN X AND Y
-- (cas par boutique via join, cas par teammate via author_teammate_id séparé)
CREATE INDEX IF NOT EXISTS ix_msg_direction_draft_created
  ON sav_messages (direction, is_draft, created_at);

-- Index spécifique pour le sub-query MAX(created_at) FILTER par type
-- dans sav_events (utilisé partout : inbound/out_reply/archive).
CREATE INDEX IF NOT EXISTS ix_evt_conv_type_created
  ON sav_events (conversation_id, type, created_at DESC);
