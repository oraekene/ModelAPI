-- Close the free-variant join gap.
--
-- Benchmark scores are keyed by the base permaslug (`openai/gpt-oss-20b`)
-- while the catalog also lists the free variant (`openai/gpt-oss-20b:free`).
-- The rank query LEFT JOINs `scores s ON s.model_id = o.model_id`, which never
-- matches a variant — every free offering silently lost its Q term and the
-- free tier had nothing to rank. `score_key` carries the base slug so both the
-- model-level score and the harness score reach the free rows.

ALTER TABLE offerings ADD COLUMN score_key TEXT;

UPDATE offerings
   SET score_key = CASE
         WHEN instr(model_id, ':') > 0 THEN substr(model_id, 1, instr(model_id, ':') - 1)
         ELSE model_id
       END
 WHERE score_key IS NULL;

CREATE INDEX IF NOT EXISTS idx_offerings_score_key ON offerings(score_key);

-- Daily token totals per model, from GET /api/v1/datasets/rankings-daily.
-- `score_key` mirrors the offering column so usage can be joined the same way.
-- The reserved `other` row is not stored: it is the long-tail denominator and
-- never an offering.
CREATE TABLE IF NOT EXISTS usage_rankings (
  date             TEXT NOT NULL,   -- UTC YYYY-MM-DD
  model_permaslug  TEXT NOT NULL,   -- raw slug, incl ':free' variants
  score_key        TEXT NOT NULL,   -- normalised base slug, joins offerings
  total_tokens     INTEGER NOT NULL, -- prompt + completion, provider tokeniser
  PRIMARY KEY (date, model_permaslug)
);

CREATE INDEX IF NOT EXISTS idx_usage_rankings_score_key ON usage_rankings(score_key);
CREATE INDEX IF NOT EXISTS idx_usage_rankings_date ON usage_rankings(date);