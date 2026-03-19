import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('render.com')
    ? { rejectUnauthorized: false }
    : false,
});

let initialized = false;

export async function initDB() {
  if (initialized) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      inbox_id TEXT NOT NULL DEFAULT '',
      instructions TEXT DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_files (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS shared_files (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      assigned_to TEXT NOT NULL DEFAULT 'all',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      chat_key TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agent_files_agent_id ON agent_files(agent_id);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_key ON chat_messages(chat_key);
  `);

  // Migrations
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE agents ADD COLUMN inbox_id TEXT NOT NULL DEFAULT '';
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$;
    DO $$ BEGIN
      ALTER TABLE agents ADD COLUMN store_code TEXT DEFAULT '';
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$;
  `);

  // Utilisateurs
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  // Utilisateurs
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  // Conversations Claude persistées (historique par client/agent)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS claude_conversations (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      front_conversation_id TEXT NOT NULL,
      subject TEXT DEFAULT '',
      status TEXT DEFAULT 'open',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(agent_id, front_conversation_id)
    );

    CREATE TABLE IF NOT EXISTS claude_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES claude_conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_claude_messages_conv ON claude_messages(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_claude_conversations_front ON claude_conversations(front_conversation_id);
  `);

  // Cache résumés Claude
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      summary TEXT NOT NULL DEFAULT '',
      quote_ready BOOLEAN NOT NULL DEFAULT FALSE,
      quote_ready_reason TEXT NOT NULL DEFAULT '',
      last_message_ts BIGINT NOT NULL DEFAULT 0,
      cached_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conversation_draft_cache (
      conversation_id TEXT PRIMARY KEY,
      has_draft BOOLEAN NOT NULL DEFAULT FALSE,
      cached_at TEXT NOT NULL
    );
  `);

  initialized = true;
}

export default pool;
