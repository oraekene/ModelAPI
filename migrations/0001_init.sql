-- ModelMap v2 — initial schema (steps 3–9)
--
-- The store is a matrix, not a list: `offerings` is keyed by
--   (model_id, harness_id, plan_id)
-- because the same model genuinely behaves differently per row. Claude Opus in
-- Cline is not Claude Opus in Claude Code — the harness controls context
-- management, tool execution and error recovery. A single row per model
-- silently destroys exactly the distinction this tool exists to make.
--
-- Scores are keyed by (model_id, harness_id, benchmark) because the SAME
-- model under DIFFERENT harnesses legitimately has different scores on the
-- same benchmark (Terminal-Bench scores model + harness together).

-- The candidate offerings: one row per (model × harness × plan).
CREATE TABLE IF NOT EXISTS offerings (
  model_id         TEXT NOT NULL,
  harness_id       TEXT NOT NULL,   -- openrouter-api | opencode-cli | claude-web | cursor | ...
  plan_id          TEXT NOT NULL,   -- 'free' | 'paid'
  medium           TEXT NOT NULL,   -- api | chat | ide | cli | desktop-agent
  context_window   INTEGER,
  supports_vision  INTEGER NOT NULL DEFAULT 0,
  supports_tools   INTEGER NOT NULL DEFAULT 0,
  is_free          INTEGER NOT NULL DEFAULT 0,
  price_prompt     REAL,
  price_completion REAL,
  access_url       TEXT,
  last_verified_at TEXT,
  PRIMARY KEY (model_id, harness_id, plan_id)
);

CREATE INDEX IF NOT EXISTS idx_offerings_free   ON offerings(is_free);
CREATE INDEX IF NOT EXISTS idx_offerings_harness ON offerings(harness_id);

-- Benchmark scores. `harness_id` empty means the score is for the model on
-- its own (Artificial Analysis / Design Arena through OpenRouter); a non-empty
-- harness_id means it was measured INSIDE that harness (Terminal-Bench).
-- `normalised` is the 0–100 term value precomputed at ingest time for
-- harness scores; model-level scores are normalised at rank time.
CREATE TABLE IF NOT EXISTS scores (
  model_id    TEXT NOT NULL,
  harness_id  TEXT NOT NULL DEFAULT '',
  benchmark   TEXT NOT NULL,
  value       REAL,
  normalised  REAL,                 -- H term for harness-measured rows
  score_scope TEXT NOT NULL DEFAULT 'model_only_inferred',
  source      TEXT,                 -- artificial-analysis | design-arena | terminal-bench
  as_of       TEXT,
  PRIMARY KEY (model_id, harness_id, benchmark)
);

CREATE INDEX IF NOT EXISTS idx_scores_benchmark ON scores(benchmark);

-- One row per sync run. `status` is 'running' | 'ok' | 'partial'.
CREATE TABLE IF NOT EXISTS sync_runs (
  run_id       TEXT PRIMARY KEY,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  status       TEXT NOT NULL DEFAULT 'running',
  slices_total INTEGER NOT NULL DEFAULT 0,
  slices_done  INTEGER NOT NULL DEFAULT 0,
  note         TEXT
);

-- What each upstream source actually returned, so the "what can my key see"
-- question is answered by the worker itself rather than a manual curl probe.
CREATE TABLE IF NOT EXISTS source_capabilities (
  source        TEXT NOT NULL,
  field_path    TEXT NOT NULL,
  available     INTEGER NOT NULL,   -- 0/1: field arrived non-null on the last ingest
  tier_reported TEXT,               -- version/tier the source reported
  observed_at   TEXT NOT NULL,
  PRIMARY KEY (source, field_path)
);

-- The benchmark used per category, and any per-user override.
-- Adding a row here adds a category to the board with NO code change.
CREATE TABLE IF NOT EXISTS category_benchmarks (
  category         TEXT PRIMARY KEY,
  default_benchmark TEXT NOT NULL,
  user_override    TEXT
);

-- Top-3 snapshots per (category, tier), the input to alert detection.
CREATE TABLE IF NOT EXISTS rank_history (
  category    TEXT NOT NULL,
  tier        TEXT NOT NULL,
  rank        INTEGER NOT NULL,
  model_id    TEXT NOT NULL,
  harness_id  TEXT NOT NULL,
  plan_id     TEXT NOT NULL,
  score       REAL NOT NULL,
  captured_at TEXT NOT NULL,
  PRIMARY KEY (category, tier, rank)
);

-- One row per identity. Both surfaces (web + Telegram) read this.
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id             TEXT PRIMARY KEY,
  telegram_chat_id    TEXT,
  free_only           INTEGER NOT NULL DEFAULT 1,
  min_context         INTEGER NOT NULL DEFAULT 0,
  alerts_enabled      INTEGER NOT NULL DEFAULT 0,
  alert_threshold_pct REAL NOT NULL DEFAULT 3
);

-- Single-use, expiring magic-link tokens; the browser-identity anchor.
CREATE TABLE IF NOT EXISTS link_tokens (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed   INTEGER NOT NULL DEFAULT 0
);

-- Seed the category → benchmark mapping. Categories match the classifier in
-- classify.ts; the benchmarks match names used by src/ranking.ts.
INSERT OR IGNORE INTO category_benchmarks (category, default_benchmark) VALUES
  ('coding',   'aa_coding_index'),
  ('general',  'aa_intelligence_index'),
  ('agentic',  'aa_agentic_index'),
  ('dataviz',  'da_dataviz_elo'),
  ('ui',       'da_uicomponent_elo'),
  ('gamedev',  'da_gamedev_elo'),
  ('svg',      'da_svg_elo');