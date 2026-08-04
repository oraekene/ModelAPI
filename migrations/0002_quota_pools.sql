-- ModelMap v2 — quota pools (step 7)
--
-- THE CORRECTION THIS MIGRATION ENCODES:
--
-- v2 §4 modelled quota as a column on `offerings`, implying each model carries
-- its own allowance. That is wrong for the dominant case. OpenRouter's docs are
-- explicit: "Making additional accounts or API keys will not affect your rate
-- limits, as we govern capacity globally." Every `:free` model on OpenRouter
-- draws from ONE shared daily bucket — spending it on DeepSeek leaves none for
-- Qwen.
--
-- So quota is a property of a PLATFORM + ACCOUNT STATE, not of a model. Pools
-- are first-class, and offerings point at them.
--
-- Consequence for scoring, stated plainly: the K term does NOT discriminate
-- between models on the same platform, because their quota is identical by
-- construction. It discriminates ACROSS platforms — OpenRouter free vs Google
-- AI Studio vs Groq. That is still valuable, and it is what K was always
-- actually measuring.

CREATE TABLE IF NOT EXISTS quota_pools (
  pool_id          TEXT PRIMARY KEY,   -- 'openrouter-free', 'google-ai-studio-free'
  platform         TEXT NOT NULL,
  label            TEXT NOT NULL,

  quota_unit       TEXT,               -- 'requests_per_day' | 'requests_per_minute' | ...
  quota_value      REAL,               -- baseline allowance
  secondary_unit   TEXT,               -- a second simultaneous cap, e.g. RPM alongside RPD
  secondary_value  REAL,

  -- Some pools have a higher tier unlocked by a condition the USER may or may
  -- not have met. Stored rather than collapsed, so the answer can be
  -- personalised instead of guessed.
  conditional_value REAL,
  condition_key     TEXT,              -- 'openrouter_paid_credits'
  condition_note    TEXT,              -- 'after $10 lifetime credit purchase'

  -- 1 = one bucket shared by every model on the platform (the OpenRouter case).
  -- 0 = each model has its own allowance.
  is_shared        INTEGER NOT NULL DEFAULT 1,

  source_url       TEXT NOT NULL,
  -- 'live'    : read from the provider's own API this run — authoritative
  -- 'stated'  : scraped from the provider's own docs
  -- 'inferred': derived, or from a third party
  -- 'stale'   : last verification is old or failed
  confidence       TEXT NOT NULL DEFAULT 'stated',
  notes            TEXT,
  last_verified_at TEXT
);

-- Offerings reference a pool rather than carrying their own numbers.
ALTER TABLE offerings ADD COLUMN pool_id TEXT;

CREATE INDEX IF NOT EXISTS idx_offerings_pool ON offerings(pool_id);

-- Records disagreement between sources instead of silently picking one.
-- Third-party guides variously claim 50, 200 and 1000 requests/day for the same
-- OpenRouter tier; only the provider's own docs settle it.
CREATE TABLE IF NOT EXISTS quota_observations (
  pool_id     TEXT NOT NULL,
  source_url  TEXT NOT NULL,
  quota_unit  TEXT,
  quota_value REAL,
  observed_at TEXT NOT NULL,
  agrees      INTEGER,               -- 1 if it matches the accepted value
  PRIMARY KEY (pool_id, source_url, observed_at)
);

-- Per-user account state that selects between pool tiers.
ALTER TABLE user_preferences ADD COLUMN openrouter_paid_credits INTEGER DEFAULT 0;

-- Seed the pools whose values come from provider documentation.
-- Values are placeholders refreshed by the scraper; source_url is what matters.
INSERT OR IGNORE INTO quota_pools
  (pool_id, platform, label, quota_unit, quota_value, secondary_unit, secondary_value,
   conditional_value, condition_key, condition_note, is_shared, source_url, confidence, notes)
VALUES
  ('openrouter-free', 'openrouter', 'OpenRouter free models',
   'requests_per_day', 50, 'requests_per_minute', 20,
   1000, 'openrouter_paid_credits', 'after $10 lifetime credit purchase',
   1, 'https://openrouter.ai/docs/api_reference/limits', 'stated',
   'Shared globally across all :free models and all keys on the account. Failed 429s still consume the daily allowance.'),

  ('google-ai-studio-free', 'google', 'Google AI Studio free tier',
   'requests_per_day', NULL, 'requests_per_minute', NULL,
   NULL, NULL, NULL,
   0, 'https://ai.google.dev/gemini-api/docs/rate-limits', 'stale',
   'Per-model limits, not pooled. Needs scraping.'),

  ('groq-free', 'groq', 'Groq free tier',
   'requests_per_day', NULL, 'requests_per_minute', NULL,
   NULL, NULL, NULL,
   0, 'https://console.groq.com/docs/rate-limits', 'stale',
   'Per-model limits. Needs scraping.');
