-- scraper_health: per-source health tracking for the Universal Scraper Network.
-- One row per scraper, updated after each run.

CREATE TABLE IF NOT EXISTS scraper_health (
  scraper_id TEXT PRIMARY KEY,
  last_run_at TEXT,
  last_status TEXT DEFAULT 'never_run',  -- ok | error | timeout | never_run
  last_error TEXT,
  consecutive_failures INTEGER DEFAULT 0,
  models_found INTEGER DEFAULT 0,
  scores_written INTEGER DEFAULT 0
);
