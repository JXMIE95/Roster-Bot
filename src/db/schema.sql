-- Guild settings
CREATE TABLE IF NOT EXISTS guild_settings (
  guild_id TEXT PRIMARY KEY,
  king_role_id TEXT,
  buff_role_id TEXT,
  category_id TEXT,
  panel_channel_id TEXT,
  panel_message_id TEXT,
  notify_lead_minutes INTEGER DEFAULT 15,
  king_change_lead_minutes INTEGER DEFAULT 10,
  timezone TEXT DEFAULT 'UTC'
);

-- Ensure buff_role_id exists even if the table was created before it was added
ALTER TABLE guild_settings
  ADD COLUMN IF NOT EXISTS buff_role_id TEXT;

-- Users cache (optional)
CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  username TEXT
);

-- Roster assignments
CREATE TABLE IF NOT EXISTS shifts (
  id BIGSERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  date_utc DATE NOT NULL,
  hour INTEGER NOT NULL CHECK (hour BETWEEN 0 AND 23),
  user_id TEXT NOT NULL,
  created_by TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_shift ON shifts(guild_id, date_utc, hour, user_id);
CREATE INDEX IF NOT EXISTS idx_slot ON shifts(guild_id, date_utc, hour);

-- Reminders idempotency
CREATE TABLE IF NOT EXISTS reminders_sent (
  id BIGSERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  date_utc DATE NOT NULL,
  hour INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,             -- 'user', 'king'
  UNIQUE(guild_id, date_utc, hour, user_id, kind)
);

-- Track per-slot change checks (legacy/future use)
CREATE TABLE IF NOT EXISTS slot_change_checks (
  id BIGSERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  date_utc DATE NOT NULL,
  hour INTEGER NOT NULL,
  checked_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  UNIQUE(guild_id, date_utc, hour)
);

-- Track the single roster message per day channel
CREATE TABLE IF NOT EXISTS day_channels (
  id BIGSERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  date_utc DATE NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  UNIQUE(guild_id, date_utc)
);