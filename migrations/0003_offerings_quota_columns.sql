-- offerings gains the per-offering quota override columns. The pool (0002)
-- is the primary quota source; these columns let a single offering override
-- its pool (e.g. a model with its own published allowance).
ALTER TABLE offerings ADD COLUMN quota_unit TEXT;
ALTER TABLE offerings ADD COLUMN quota_value REAL;
ALTER TABLE offerings ADD COLUMN quota_confidence TEXT;
