-- Table d'analyse Claude par message inbound.
-- Lien 1-N avec sav_messages (re-runs possibles via prompt_version).
CREATE TABLE IF NOT EXISTS sav_message_analysis (
  id              SERIAL PRIMARY KEY,
  message_id      TEXT NOT NULL REFERENCES sav_messages(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES sav_conversations(id) ON DELETE CASCADE,
  analyzed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  prompt_version  TEXT NOT NULL DEFAULT 'v1',
  category        TEXT,
  sentiment       TEXT CHECK (sentiment IN ('positif','neutre','négatif','très_négatif')),
  urgency         BOOLEAN DEFAULT FALSE,
  summary         TEXT,
  tags            TEXT[],
  language        TEXT,
  raw_response    JSONB
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_msg_analysis_msg_version
  ON sav_message_analysis(message_id, prompt_version);

CREATE INDEX IF NOT EXISTS ix_msg_analysis_analyzed_at
  ON sav_message_analysis(analyzed_at DESC);

CREATE INDEX IF NOT EXISTS ix_msg_analysis_sentiment_at
  ON sav_message_analysis(sentiment, analyzed_at DESC);

CREATE INDEX IF NOT EXISTS ix_msg_analysis_urgency_at
  ON sav_message_analysis(analyzed_at DESC) WHERE urgency = true;
