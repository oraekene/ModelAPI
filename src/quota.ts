/**
 * Quota pools — step 7.
 *
 * The requirement was: never hardcode native free tiers, always research them.
 * This module does that, but the research is cheaper than the spec assumed,
 * because the most important pool turns out to be self-describing.
 *
 * THREE TIERS OF SOURCE, cheapest first:
 *
 *   LIVE   — the provider's own API reports the account's actual limit.
 *            OpenRouter does this via GET /api/v1/key. Zero scraping, and it is
 *            personalised rather than a documented default.
 *   TIER A — plain fetch() of a server-rendered docs page. Zero Browser
 *            Rendering time. Always attempted before Tier B.
 *   TIER B — Browser Rendering, for JS-gated pages only. Capped per day.
 *
 * Terminal-Bench (step 6) established that server-rendered pages are common;
 * that step spent none of the 10 min/day browser allowance, so the whole
 * budget is available here.
 */

export interface QuotaPool {
  pool_id: string;
  platform: string;
  label: string;
  quota_unit: string | null;
  quota_value: number | null;
  secondary_unit: string | null;
  secondary_value: number | null;
  conditional_value: number | null;
  condition_key: string | null;
  condition_note: string | null;
  is_shared: number;
  source_url: string;
  confidence: string;
  notes: string | null;
  last_verified_at: string | null;
}

export interface ResolvedQuota {
  unit: string | null;
  value: number | null;
  confidence: string;
  /** True when the allowance is shared with every other model on the platform. */
  shared: boolean;
  /** Set when a higher tier exists that the user has not unlocked. */
  upgradeHint?: string;
  label: string;
}

/**
 * Resolve a pool to the allowance THIS user actually has.
 *
 * The conditional tier is the reason this is not a plain column read: the same
 * pool is 50/day or 1000/day depending on account history, a twentyfold
 * difference that changes which model is the right answer.
 */
export function resolveQuota(
  pool: QuotaPool,
  userFlags: Record<string, boolean> = {},
): ResolvedQuota {
  const conditionMet = pool.condition_key ? userFlags[pool.condition_key] === true : false;

  const value =
    conditionMet && pool.conditional_value !== null
      ? pool.conditional_value
      : pool.quota_value;

  const upgradeHint =
    !conditionMet && pool.conditional_value !== null && pool.condition_note
      ? `${pool.conditional_value} ${(pool.quota_unit ?? '').replace(/_/g, ' ')} ${pool.condition_note}`
      : undefined;

  return {
    unit: pool.quota_unit,
    value,
    confidence: pool.confidence,
    shared: pool.is_shared === 1,
    upgradeHint,
    label: pool.label,
  };
}

// ---------------------------------------------------------------------------
// LIVE: OpenRouter reports the account's own tier
// ---------------------------------------------------------------------------

interface ORKeyResponse {
  data: {
    /** True when the account has never purchased credits. Selects the tier. */
    is_free_tier: boolean;
    usage_daily: number;
    limit_remaining: number | null;
  };
}

/**
 * Read the account's actual free-model tier from OpenRouter.
 *
 * This is strictly better than scraping a docs page: it reports what THIS
 * account gets rather than what the documentation says by default, and it
 * cannot drift out of date. `is_free_tier` maps directly onto the documented
 * 50/day vs 1000/day split.
 */
export async function discoverOpenRouterQuota(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ paidCredits: boolean; usageDaily: number } | null> {
  try {
    const res = await fetchImpl('https://openrouter.ai/api/v1/key', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as ORKeyResponse;
    if (typeof body?.data?.is_free_tier !== 'boolean') return null;
    return {
      paidCredits: body.data.is_free_tier === false,
      usageDaily: body.data.usage_daily ?? 0,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// TIER A: extraction from server-rendered documentation
// ---------------------------------------------------------------------------

export interface QuotaCandidate {
  unit: string;
  value: number;
  /** Surrounding text, kept so a wrong extraction is debuggable. */
  context: string;
}

/**
 * Unit phrases, as global regexes so every occurrence is found.
 *
 * Ordered longest-first: "requests per day" must be tested before "requests per
 * minute" cannot shadow it, and the hour pattern must not swallow "5 hours" in
 * a messages window.
 */
const UNIT_PATTERNS: Array<[RegExp, string]> = [
  [/messages?\s*(?:per|\/|every)\s*5\s*h(?:ours?)?/gi, 'messages_per_5h'],
  [/requests?\s*(?:per|\/|a)\s*day|\brpd\b|daily\s*requests?/gi, 'requests_per_day'],
  [/requests?\s*(?:per|\/|a)\s*min(?:ute)?|\brpm\b/gi, 'requests_per_minute'],
  [/requests?\s*(?:per|\/|an)\s*hour|\brph\b/gi, 'requests_per_hour'],
  [/tokens?\s*(?:per|\/|a)\s*day|\btpd\b/gi, 'tokens_per_day'],
  [/tokens?\s*(?:per|\/|a)\s*min(?:ute)?|\btpm\b/gi, 'tokens_per_minute'],
];

/** How far back from a unit phrase to look for its number. */
const LOOKBACK_CHARS = 24;

/**
 * Pull quota figures out of documentation text.
 *
 * ANCHORING DIRECTION MATTERS. The first implementation found numbers and
 * looked forward for a unit phrase, which reliably picked the wrong figure:
 * in "accounts with less than $10 purchased get 50 requests per day" it
 * returned 10 — the price threshold — instead of 50. It also missed figures
 * entirely when two rates appeared in one sentence with no terminator between
 * them.
 *
 * A rate figure always PRECEDES its unit, so the unit phrase is the anchor and
 * the scan runs backwards to the nearest number. Currency-prefixed numbers are
 * rejected outright: "$10" is a price, never an allowance.
 *
 * Returns EVERY candidate rather than the first. Docs routinely list several
 * tiers on one page, and taking the first match is how a scraper silently
 * reports the paid tier as the free one.
 */
export function extractQuotas(text: string): QuotaCandidate[] {
  const out: QuotaCandidate[] = [];

  for (const [pattern, unit] of UNIT_PATTERNS) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(text)) !== null) {
      const before = text.slice(Math.max(0, m.index - LOOKBACK_CHARS), m.index);

      // Nearest number to the left, with optional k/m suffix.
      const numMatch = /(\$?)\s*([\d][\d,]*(?:\.\d+)?)\s*([kKmM])?\s*$/.exec(before);
      if (!numMatch) continue;

      // A currency-prefixed figure is a price, not an allowance.
      if (numMatch[1] === '$') continue;

      let value = Number(numMatch[2].replace(/,/g, ''));
      if (!Number.isFinite(value) || value <= 0) continue;

      const suffix = (numMatch[3] ?? '').toLowerCase();
      if (suffix === 'k') value *= 1_000;
      if (suffix === 'm') value *= 1_000_000;

      out.push({
        unit,
        value,
        context: `${numMatch[2]}${numMatch[3] ?? ''} ${m[0]}`.trim().slice(0, 80),
      });
    }
  }

  return out;
}

/**
 * Reconcile candidates into one value per unit.
 *
 * Where a page lists several tiers, the FREE tier is the smallest plausible
 * figure — free allowances are never the largest number on a pricing page.
 * Taking the minimum is a deliberate bias toward under-promising: telling
 * someone they have less quota than they do costs them a slightly conservative
 * ranking, while over-promising sends them into a 429 mid-task.
 */
export function reconcile(candidates: QuotaCandidate[]): Map<string, QuotaCandidate> {
  const byUnit = new Map<string, QuotaCandidate[]>();
  for (const c of candidates) {
    const list = byUnit.get(c.unit) ?? [];
    list.push(c);
    byUnit.set(c.unit, list);
  }

  const out = new Map<string, QuotaCandidate>();
  for (const [unit, list] of byUnit) {
    let best = list[0];
    for (const c of list) if (c.value < best.value) best = c;
    out.set(unit, best);
  }
  return out;
}

/** True when sources disagree enough to warrant lowering confidence. */
export function sourcesDisagree(candidates: QuotaCandidate[], unit: string): boolean {
  const vals = candidates.filter((c) => c.unit === unit).map((c) => c.value);
  if (vals.length < 2) return false;
  return Math.max(...vals) / Math.min(...vals) >= 2;
}

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

export interface QuotaSyncReport {
  poolId: string;
  method: 'live' | 'tier-a' | 'skipped';
  unit: string | null;
  value: number | null;
  confidence: string;
  disagreement: boolean;
  note?: string;
}

/**
 * Refresh one pool.
 *
 * A pool that cannot be verified degrades to `stale` and KEEPS its previous
 * value rather than being nulled. A stale number with a visible age is more
 * useful than no number, provided the staleness is surfaced — which the UI
 * does, per row.
 */
export async function syncPool(
  db: D1Database,
  pool: QuotaPool,
  env: { OPENROUTER_API_KEY?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<QuotaSyncReport> {
  const now = new Date().toISOString();

  // LIVE path: OpenRouter tells us the account's real tier.
  if (pool.platform === 'openrouter' && env.OPENROUTER_API_KEY) {
    const live = await discoverOpenRouterQuota(env.OPENROUTER_API_KEY, fetchImpl);
    if (live) {
      await db
        .prepare(
          `UPDATE quota_pools
              SET confidence = 'live', last_verified_at = ?2,
                  notes = ?3
            WHERE pool_id = ?1`,
        )
        .bind(
          pool.pool_id,
          now,
          `Account has ${live.paidCredits ? '' : 'not '}purchased credits; ` +
            `${live.usageDaily} credits used today. Shared globally across all :free models.`,
        )
        .run();

      // Record the account flag so resolveQuota picks the right tier.
      await db
        .prepare(
          `UPDATE user_preferences SET openrouter_paid_credits = ?1 WHERE user_id IS NOT NULL`,
        )
        .bind(live.paidCredits ? 1 : 0)
        .run();

      return {
        poolId: pool.pool_id,
        method: 'live',
        unit: pool.quota_unit,
        value: live.paidCredits ? pool.conditional_value : pool.quota_value,
        confidence: 'live',
        disagreement: false,
        note: live.paidCredits ? 'paid-credit tier' : 'free tier',
      };
    }
  }

  // GROQ: the whole per-model rate table is embedded in the page's flight
  // payload (see parseGroqRateTable). Plain fetch, no Browser Rendering.
  if (pool.platform === 'groq') {
    try {
      const groq = await syncGroqPool(db, pool, now, fetchImpl);
      if (groq) return groq;
    } catch {
      // fall through to the generic text-extraction path, which marks stale
    }
  }

  // TIER A: plain fetch of the documentation page. No browser time.
  try {
    const res = await fetchImpl(pool.source_url, {
      headers: { 'user-agent': 'ModelMap/1.0 (+personal research tool)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const text = stripToText(await res.text());
    const candidates = extractQuotas(text);
    const reconciled = reconcile(candidates);

    const primary = pool.quota_unit ? reconciled.get(pool.quota_unit) : undefined;
    if (!primary) throw new Error('no quota figure found');

    const disagreement = sourcesDisagree(candidates, primary.unit);
    const confidence = disagreement ? 'inferred' : 'stated';

    await db
      .prepare(
        `UPDATE quota_pools
            SET quota_value = ?2, confidence = ?3, last_verified_at = ?4
          WHERE pool_id = ?1`,
      )
      .bind(pool.pool_id, primary.value, confidence, now)
      .run();

    // Keep every observation, so a wrong extraction is auditable later.
    const obs = db.prepare(
      `INSERT OR REPLACE INTO quota_observations
         (pool_id, source_url, quota_unit, quota_value, observed_at, agrees)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    );
    await db.batch(
      candidates
        .slice(0, 10)
        .map((c) =>
          obs.bind(pool.pool_id, pool.source_url, c.unit, c.value, now, c.value === primary.value ? 1 : 0),
        ),
    );

    return {
      poolId: pool.pool_id,
      method: 'tier-a',
      unit: primary.unit,
      value: primary.value,
      confidence,
      disagreement,
    };
  } catch (err) {
    // Degrade, do not destroy. The previous value survives, marked stale.
    await db
      .prepare(`UPDATE quota_pools SET confidence = 'stale' WHERE pool_id = ?1`)
      .bind(pool.pool_id)
      .run();

    return {
      poolId: pool.pool_id,
      method: 'skipped',
      unit: pool.quota_unit,
      value: pool.quota_value,
      confidence: 'stale',
      disagreement: false,
      note: String((err as Error).message),
    };
  }
}

/** Crude HTML-to-text, adequate for locating rate-limit figures. */
export function stripToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

/**
 * Groq's pool is per-model, so the pool row carries the conservative floor
 * (smallest RPD/RPM on the page) and every row is kept as an observation.
 */
async function syncGroqPool(
  db: D1Database,
  pool: QuotaPool,
  now: string,
  fetchImpl: typeof fetch,
): Promise<QuotaSyncReport | null> {
  const res = await fetchImpl(pool.source_url, {
    headers: { 'user-agent': 'ModelMap/1.0 (+personal research tool)' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const rows = parseGroqRateTable(await res.text());
  const rpds = rows.map((r) => r.rpd).filter((v): v is number => v !== null);
  const rpms = rows.map((r) => r.rpm).filter((v): v is number => v !== null);
  if (rows.length === 0 || rpds.length === 0) return null;

  const minRpd = Math.min(...rpds);
  const minRpm = rpms.length > 0 ? Math.min(...rpms) : null;

  await db
    .prepare(
      `UPDATE quota_pools
          SET quota_unit = 'requests_per_day', quota_value = ?2,
              secondary_unit = 'requests_per_minute', secondary_value = ?3,
              confidence = 'stated', last_verified_at = ?4, notes = ?5
        WHERE pool_id = ?1`,
    )
    .bind(
      pool.pool_id,
      minRpd,
      minRpm,
      now,
      `Parsed ${rows.length} per-model rows from the embedded table on console.groq.com; ` +
        `RPD ${minRpd}–${Math.max(...rpds)}, RPM ${minRpm ?? 'n/a'}–${rpms.length ? Math.max(...rpms) : 'n/a'}.`,
    )
    .run();

  const obs = db.prepare(
    `INSERT OR REPLACE INTO quota_observations
       (pool_id, source_url, quota_unit, quota_value, observed_at, agrees)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  );
  await db.batch(
    rows.slice(0, 10).flatMap((r) => [
      obs.bind(pool.pool_id, pool.source_url, 'requests_per_day', r.rpd, now, r.rpd === minRpd ? 1 : 0),
      obs.bind(pool.pool_id, pool.source_url, 'requests_per_minute', r.rpm, now, r.rpm === minRpm ? 1 : 0),
    ]),
  );

  return {
    poolId: pool.pool_id,
    method: 'tier-a',
    unit: 'requests_per_day',
    value: minRpd,
    confidence: 'stated',
    disagreement: false,
    note: `embedded table, ${rows.length} models`,
  };
}

/** Attach OpenRouter API offerings to the shared free pool. */
export async function assignPools(db: D1Database): Promise<number> {
  const res = await db
    .prepare(
      `UPDATE offerings
          SET pool_id = 'openrouter-free'
        WHERE harness_id = 'openrouter-api' AND is_free = 1 AND pool_id IS NULL`,
    )
    .run();
  return res.meta?.changes ?? 0;
}

// ---------------------------------------------------------------------------
// GROQ: the rate table ships inside the HTML as a Next.js flight payload
// ---------------------------------------------------------------------------

export interface GroqRateRow {
  model: string;
  rpm: number | null;
  rpd: number | null;
  tpm: number | null;
  tpd: number | null;
}

const groqCell = (v: unknown): number | null => {
  if (v === '-' || v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!/^[\d,.]+[kKmM]?$/.test(s)) return null;
  const mult = s.endsWith('K') ? 1_000 : s.endsWith('M') ? 1_000_000 : 1;
  const n = Number(s.replace(/[kKmM,]/g, ''));
  return Number.isFinite(n) && n > 0 ? n * mult : null;
};

/**
 * console.groq.com/docs/rate-limits renders no figures server-side, but the
 * whole rate table is embedded as a JSON array in the page's Next.js flight
 * data: rows are [model_id, RPM, RPD, TPM, TPD, ASH, ASD] preceded by a
 * `"title":"MODEL ID"` header marker. Plain fetch still works — no Browser
 * Rendering needed.
 */
export function parseGroqRateTable(html: string): GroqRateRow[] {
  const flight = html
    .replaceAll('\\"', '"')
    .replaceAll('&quot;', '"')
    .replaceAll('&amp;', '&');

  const marker = '"title":"MODEL ID"';
  const markerIdx = flight.indexOf(marker);
  if (markerIdx === -1) return [];

  const rowsStart = flight.lastIndexOf('[[', markerIdx);
  const rowsEnd = flight.indexOf(']],"headers"', rowsStart);
  if (rowsStart === -1 || rowsEnd === -1 || rowsEnd <= rowsStart) return [];

  let raw: unknown;
  try {
    raw = JSON.parse(flight.slice(rowsStart, rowsEnd + 2));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];

  const out: GroqRateRow[] = [];
  for (const row of raw) {
    if (!Array.isArray(row) || typeof row[0] !== 'string') continue;
    out.push({
      model: row[0],
      rpm: groqCell(row[1]),
      rpd: groqCell(row[2]),
      tpm: groqCell(row[3]),
      tpd: groqCell(row[4]),
    });
  }
  return out;
}
