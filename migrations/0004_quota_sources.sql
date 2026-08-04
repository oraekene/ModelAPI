-- Google's gemini-api rate-limits page renders its figures client-side, so
-- tier-a text extraction finds nothing there. The pricing page is
-- server-rendered and states the free-tier RPD outright ("Free of charge, up
-- to 500 RPD (limit shared with Flash-Lite RPD)").
UPDATE quota_pools
   SET source_url = 'https://ai.google.dev/pricing',
       notes = 'Per-model limits, not pooled. Free-tier RPD read from the pricing page (Flash/Flash-Lite share a 500 RPD bucket).'
 WHERE pool_id = 'google-ai-studio-free';
