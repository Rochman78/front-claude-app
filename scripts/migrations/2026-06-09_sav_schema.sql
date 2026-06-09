-- ═════════════════════════════════════════════════════════════
-- SAV REPORTING — SCHÉMA BDD
-- ═════════════════════════════════════════════════════════════
-- 13 tables préfixées `sav_*` pour reporting performance équipe SAV
-- (Murella, Roniah, Charles, Jérémy) sur les 9 boutiques Zephyr OSC.
--
-- Idempotent : peut être rejoué à volonté sans casser.
-- IDs natifs Front (cnv_xxx, msg_xxx, tea_xxx…) comme PK.
-- Rétention infinie (pas de purge).
-- ═════════════════════════════════════════════════════════════

-- ─── A. RÉFÉRENTIELS ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sav_inboxes (
  id          TEXT PRIMARY KEY,
  store_code  TEXT,
  name        TEXT NOT NULL,
  type        TEXT,                     -- email | chat | custom
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sav_teammates (
  id            TEXT PRIMARY KEY,
  email         TEXT,
  name          TEXT NOT NULL,
  role          TEXT,
  is_admin      BOOLEAN DEFAULT FALSE,
  weekly_hours  NUMERIC DEFAULT 0,
  contract_type TEXT,                   -- salarié | admin | freelance
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sav_tags (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  color      TEXT,
  category   TEXT,                      -- devis | sav | bruit | autre (calculé)
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sav_channels (
  id         TEXT PRIMARY KEY,
  inbox_id   TEXT REFERENCES sav_inboxes(id) ON DELETE SET NULL,
  type       TEXT,                      -- email | chat | instagram | facebook
  name       TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sav_holidays (
  date  DATE PRIMARY KEY,
  name  TEXT NOT NULL
);

-- ─── B. ENTITÉS PRINCIPALES ──────────────────────────────────

CREATE TABLE IF NOT EXISTS sav_conversations (
  id                              TEXT PRIMARY KEY,
  inbox_id                        TEXT REFERENCES sav_inboxes(id) ON DELETE SET NULL,
  store_code                      TEXT,
  channel_id                      TEXT REFERENCES sav_channels(id) ON DELETE SET NULL,
  subject                         TEXT,
  status                          TEXT,
  assignee_id                     TEXT REFERENCES sav_teammates(id) ON DELETE SET NULL,
  language                        TEXT,
  -- Client
  customer_email                  TEXT,
  customer_name                   TEXT,
  customer_country                TEXT,
  -- Timestamps clés
  created_at                      TIMESTAMPTZ,
  first_inbound_at                TIMESTAMPTZ,
  first_outbound_at               TIMESTAMPTZ,
  last_inbound_at                 TIMESTAMPTZ,
  last_outbound_at                TIMESTAMPTZ,
  last_event_at                   TIMESTAMPTZ,
  archived_at                     TIMESTAMPTZ,
  archived_by_teammate_id         TEXT REFERENCES sav_teammates(id) ON DELETE SET NULL,
  -- KPIs pré-calculés
  response_time_seconds           INT,
  response_time_business_seconds  INT,
  is_within_sla                   BOOLEAN,
  is_noise                        BOOLEAN DEFAULT FALSE,
  -- Compteurs
  total_inbound_messages          INT DEFAULT 0,
  total_outbound_messages         INT DEFAULT 0,
  total_comments                  INT DEFAULT 0,
  total_events                    INT DEFAULT 0,
  -- Typologie
  demand_type                     TEXT,
  -- Audit sync
  synced_at                       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sav_messages (
  id                  TEXT PRIMARY KEY,
  conversation_id     TEXT REFERENCES sav_conversations(id) ON DELETE CASCADE,
  direction           TEXT NOT NULL,   -- in | out
  author_email        TEXT,
  author_teammate_id  TEXT REFERENCES sav_teammates(id) ON DELETE SET NULL,
  channel_id          TEXT REFERENCES sav_channels(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL,
  body_text           TEXT,
  body_html           TEXT,
  text_length         INT,
  has_attachments     BOOLEAN DEFAULT FALSE,
  attachment_count    INT DEFAULT 0,
  is_draft            BOOLEAN DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS sav_comments (
  id                  TEXT PRIMARY KEY,
  conversation_id     TEXT REFERENCES sav_conversations(id) ON DELETE CASCADE,
  author_teammate_id  TEXT REFERENCES sav_teammates(id) ON DELETE SET NULL,
  body_text           TEXT,
  created_at          TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS sav_events (
  id                  TEXT PRIMARY KEY,
  conversation_id     TEXT REFERENCES sav_conversations(id) ON DELETE CASCADE,
  type                TEXT NOT NULL,   -- archive | assign | unassign | tag | untag | reopen | transfer
  actor_teammate_id   TEXT REFERENCES sav_teammates(id) ON DELETE SET NULL,
  target_teammate_id  TEXT REFERENCES sav_teammates(id) ON DELETE SET NULL,
  tag_id              TEXT REFERENCES sav_tags(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL,
  meta                JSONB
);

CREATE TABLE IF NOT EXISTS sav_attachments (
  id            TEXT PRIMARY KEY,
  message_id    TEXT REFERENCES sav_messages(id) ON DELETE CASCADE,
  filename      TEXT,
  content_type  TEXT,
  size_bytes    BIGINT,
  is_inline     BOOLEAN DEFAULT FALSE,
  metadata      JSONB
);

-- ─── C. LIENS N-N ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sav_conversation_tags (
  conversation_id         TEXT REFERENCES sav_conversations(id) ON DELETE CASCADE,
  tag_id                  TEXT REFERENCES sav_tags(id) ON DELETE CASCADE,
  applied_at              TIMESTAMPTZ NOT NULL,
  applied_by_teammate_id  TEXT REFERENCES sav_teammates(id) ON DELETE SET NULL,
  removed_at              TIMESTAMPTZ,
  PRIMARY KEY (conversation_id, tag_id, applied_at)
);

CREATE TABLE IF NOT EXISTS sav_conversation_assignees_history (
  conversation_id  TEXT REFERENCES sav_conversations(id) ON DELETE CASCADE,
  teammate_id      TEXT REFERENCES sav_teammates(id) ON DELETE CASCADE,
  assigned_at      TIMESTAMPTZ NOT NULL,
  unassigned_at    TIMESTAMPTZ,
  PRIMARY KEY (conversation_id, teammate_id, assigned_at)
);

-- ─── D. OPÉRATIONNEL ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sav_sync_log (
  id                      SERIAL PRIMARY KEY,
  started_at              TIMESTAMPTZ NOT NULL,
  finished_at             TIMESTAMPTZ,
  status                  TEXT,                -- success | partial | failed
  duration_seconds        INT,
  conversations_seen      INT DEFAULT 0,
  conversations_upserted  INT DEFAULT 0,
  messages_upserted       INT DEFAULT 0,
  comments_upserted       INT DEFAULT 0,
  events_upserted         INT DEFAULT 0,
  errors_count            INT DEFAULT 0,
  error_details           JSONB
);

-- ─── INDEXES (requêtes reporting < 100ms) ────────────────────

CREATE INDEX IF NOT EXISTS ix_conv_store_created     ON sav_conversations(store_code, created_at);
CREATE INDEX IF NOT EXISTS ix_conv_first_inbound     ON sav_conversations(first_inbound_at);
CREATE INDEX IF NOT EXISTS ix_conv_archived_at       ON sav_conversations(archived_at);
CREATE INDEX IF NOT EXISTS ix_conv_assignee          ON sav_conversations(assignee_id);
CREATE INDEX IF NOT EXISTS ix_conv_is_noise          ON sav_conversations(is_noise) WHERE is_noise = false;
CREATE INDEX IF NOT EXISTS ix_conv_language          ON sav_conversations(language);
CREATE INDEX IF NOT EXISTS ix_conv_demand_type       ON sav_conversations(demand_type);

CREATE INDEX IF NOT EXISTS ix_msg_conv_created       ON sav_messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS ix_msg_teammate_created   ON sav_messages(author_teammate_id, created_at) WHERE direction = 'out';
CREATE INDEX IF NOT EXISTS ix_msg_direction_created  ON sav_messages(direction, created_at);

CREATE INDEX IF NOT EXISTS ix_cmt_teammate_created   ON sav_comments(author_teammate_id, created_at);

CREATE INDEX IF NOT EXISTS ix_evt_type_actor_created ON sav_events(type, actor_teammate_id, created_at);
CREATE INDEX IF NOT EXISTS ix_evt_conv_type          ON sav_events(conversation_id, type);

CREATE INDEX IF NOT EXISTS ix_convtag_tag            ON sav_conversation_tags(tag_id) WHERE removed_at IS NULL;

-- ═════════════════════════════════════════════════════════════
-- Fin du schéma. Tables vides — à peupler via :
--   1. scripts/migrations/2026-06-09_sav_populate_refs.py (référentiels)
--   2. scripts/sav-sync.ts (sync delta Front API)
-- ═════════════════════════════════════════════════════════════
