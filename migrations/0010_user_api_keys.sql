-- 0010: per-key free-tier caps (freellmapi's per-key tracking, adapted).
--
-- See src/caps.ts. A free-tier allowance is per ACCOUNT (per key), so two
-- keys on one platform mean two independent allowances. Keys are stored as
-- (platform, label) only: no key material ever reaches this service. Usage is
-- recorded per key per UTC day, by the user or their tooling.

CREATE TABLE IF NOT EXISTS user_api_keys (
  key_id     TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  platform   TEXT NOT NULL,
  label      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_user_api_keys_user ON user_api_keys (user_id, platform);

CREATE TABLE IF NOT EXISTS key_usage (
  key_id     TEXT NOT NULL,
  day        TEXT NOT NULL,   -- UTC date, the window free tiers use
  requests   INTEGER NOT NULL DEFAULT 0,
  tokens     INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (key_id, day)
);
