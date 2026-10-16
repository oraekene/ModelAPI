-- scraper_blocklist: scrapers that failed repeatedly are skipped by the cron and
-- /admin/scrape until expires_at, then re-probed once (blueprint #43: probe,
-- block, expire). A successful re-probe clears the row.

CREATE TABLE IF NOT EXISTS scraper_blocklist (
  scraper_id TEXT PRIMARY KEY,
  blocked_at TEXT NOT NULL,
  reason TEXT,
  failures INTEGER DEFAULT 0,
  expires_at TEXT NOT NULL
);
