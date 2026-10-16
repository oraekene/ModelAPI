-- price_cache_read: cached-input price per token, needed by the app's value
-- metric (Option 2 blends prompt, cache-read and completion costs). First real
-- source: OpenRouter's pricing.input_cache_read.

ALTER TABLE offerings ADD COLUMN price_cache_read REAL;
