# KV Write Budget

Workers KV write budget analysis for ModelMap.

## Plan Comparison

| Plan | KV Writes/Day | KV Reads/Day | Cost |
|------|---------------|--------------|------|
| Workers Free | 1,000 | 100,000 | Free |
| Workers Paid | 100,000 | 10,000,000 | $5/mo |

## Current Usage (per sync run)

### Answer Keys (ranking results)
- 7 categories × 2 tiers = **14 writes**
- Written in `computeAndStore()` (src/ranking.ts)

### Citation & Metadata Keys
- 1 per benchmark source × 2 sources (AA + DA) = **2 writes**
- 1 usage citation = **1 write**
- 1 usage-as-of timestamp = **1 write**
- 2 terminal-bench reports = **2 writes**
- 3 quota reports (one per pool) = **3 writes**
- Total: **9 writes**

### Alert Cooldown Keys
- Varies by alert activity, typically **0-5 writes**
- TTL-based, auto-expire

**Total per run: ~23-28 KV writes**

## Budget Projections

### Workers Free (1,000 writes/day)

| Runs/Day | Writes/Run | Total/Day | Status |
|----------|------------|-----------|--------|
| 4 (every 6h) | 25 | 100 | OK |
| 6 (every 4h) | 25 | 150 | OK |
| 12 (every 2h) | 25 | 300 | OK |

**Verdict:** Sufficient for current usage. Free tier handles 40 runs/day at 25 writes each.

### With 150 Scrapers (projected)

When scrapers are added, each may produce citation keys. Conservative estimates:

| Scenario | Citations/Run | Total/Day (6 runs) | Status |
|----------|---------------|-------------------|--------|
| 10 scrapers | 10 | 180 | OK (Free) |
| 50 scrapers | 50 | 300 | OK (Free) |
| 100 scrapers | 100 | 600 | OK (Free) |
| 150 scrapers | 150 | 900 | Tight (Free) |
| 200 scrapers | 200 | 1,200 | Exceeds Free |

**Verdict:** Free tier handles up to ~130 scrapers at 6 runs/day. Beyond that, Workers Paid is needed.

### Workers Paid (100,000 writes/day)

| Runs/Day | Writes/Run | Total/Day | Headroom |
|----------|------------|-----------|----------|
| 6 (every 4h) | 25 | 150 | 99.85% |
| 6 | 150 | 900 | 99.1% |
| 6 | 500 | 3,000 | 97% |
| 24 (every 1h) | 500 | 12,000 | 88% |

**Verdict:** Workers Paid provides massive headroom for 150+ scrapers with 4-hourly sync.

## Recommendation

**Migrate to Workers Paid ($5/mo)** for:
1. **Headroom:** 100,000 writes/day vs. projected 150-900/day
2. **Future-proofing:** Supports 500+ scrapers without budget concerns
3. **CPU budget:** 30s CPU vs. 10ms on Free (enables more complex scrapers)
4. **Cron frequency:** Every 4 hours vs. every 6 hours (more timely data)

## Implementation Notes

- **Billing change only:** No code changes required for KV migration
- **Cron schedule:** Updated in `wrangler.toml` from `0 */6 * * *` to `0 */4 * * *`
- **KV namespace:** Same `CACHE` binding, no migration needed
- **Monitoring:** Use `/admin/sources` to track scraper health and KV usage

## Migration Steps

1. Go to Cloudflare Dashboard → Workers & Pages → modelmap → Settings → Usage & Billing
2. Change plan from "Free" to "Paid ($5/mo)"
3. Deploy updated `wrangler.toml` with new cron schedule
4. Verify KV writes succeed in next sync run
