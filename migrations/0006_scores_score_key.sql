-- Close the second free-variant join gap: dated build slugs.
--
-- 0005 gave offerings a `score_key` so `:free` variants inherit the base
-- model's benchmark. But the benchmark API keys SOME models on dated build
-- slugs (`nvidia/nemotron-3-super-120b-a12b-20230311`) while the catalog
-- lists the same model undated (`nvidia/nemotron-3-super-120b-a12b`), so
-- those joins still miss — even the paid row for that family has no score.
-- The scores table therefore gets its own `score_key` with the same
-- normalisation: strip `:variant`, then a trailing `-YYYYMMDD` build stamp.

ALTER TABLE scores ADD COLUMN score_key TEXT;

-- 1) strip the :variant suffix
UPDATE scores
   SET score_key = CASE
         WHEN instr(model_id, ':') > 0 THEN substr(model_id, 1, instr(model_id, ':') - 1)
         ELSE model_id
       END;

-- 2) strip a trailing -YYYYMMDD build stamp. GLOB stands in for a regex;
--    `-` followed by exactly 8 digits matches `-20230311` but NOT the
--    dash-separated canonical dates like `gpt-4o-2024-05-13`, which survive.
UPDATE scores
   SET score_key = CASE
         WHEN score_key GLOB '*-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'
           THEN substr(score_key, 1, length(score_key) - 9)
         ELSE score_key
       END;

CREATE INDEX IF NOT EXISTS idx_scores_score_key ON scores(score_key, benchmark);

-- Re-backfill offerings with the full normalisation too: 0005 only stripped
-- the variant suffix, but the catalog itself carries one dated id
-- (`qwen/qwen3.5-plus-20260420`) which must map to `qwen/qwen3.5-plus`.
UPDATE offerings
   SET score_key = CASE
         WHEN instr(model_id, ':') > 0 THEN substr(model_id, 1, instr(model_id, ':') - 1)
         ELSE model_id
       END;

UPDATE offerings
   SET score_key = CASE
         WHEN score_key GLOB '*-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'
           THEN substr(score_key, 1, length(score_key) - 9)
         ELSE score_key
       END;
