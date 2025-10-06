-- Core tables you already have (keep yours as-is). Below are safe, additive defs.

-- Tracks hourly assignments
CREATE TABLE IF NOT EXISTS shifts (
  guild_id TEXT NOT NULL,
  date_utc DATE NOT NULL,
  hour INT NOT NULL CHECK (hour BETWEEN 0 AND 23),
  user_id TEXT NOT NULL,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (guild_id, date_utc, hour, user_id)
);

-- One-time actions / reminders sent
CREATE TABLE IF NOT EXISTS reminders_sent (
  guild_id TEXT NOT NULL,
  date_utc DATE NOT NULL,
  hour INT NOT NULL CHECK (hour BETWEEN 0 AND 23),
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (guild_id, date_utc, hour, user_id, kind)
);

-- Guild-wide settings
CREATE TABLE IF NOT EXISTS guild_settings (
  guild_id TEXT PRIMARY KEY,
  category_id TEXT,
  panel_channel_id TEXT,
  panel_message_id TEXT,
  king_role_id TEXT,
  buff_role_id TEXT,
  r5_role_id TEXT,
  notify_lead_minutes INT,
  king_change_lead_minutes INT
);

-- Message upsert helper (if you already have a table for day messages, keep it)
CREATE TABLE IF NOT EXISTS day_messages (
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  date_utc DATE NOT NULL,
  PRIMARY KEY (guild_id, date_utc)
);

-- NEW: King blackouts (lock hours so members can’t self-apply)
CREATE TABLE IF NOT EXISTS king_blackouts (
  guild_id TEXT NOT NULL,
  date_utc DATE NOT NULL,
  hour INT NOT NULL CHECK (hour BETWEEN 0 AND 23),
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (guild_id, date_utc, hour)
);

CREATE INDEX IF NOT EXISTS idx_blackouts_lookup
  ON king_blackouts (guild_id, date_utc, hour);