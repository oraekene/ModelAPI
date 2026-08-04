/**
 * Rank computation — step 4.
 *
 * Reads D1, computes ranked offerings per (category, tier), writes one KV blob
 * per pair. The request path then does exactly one KV.get() and no computation.
 *
 * KV WRITE BUDGET: Workers KV Free allows 1,000 writes/day.
 *   7 categories x 2 tiers = 14 keys, refreshed 4x/day = 56 writes/day.
 *   Plus ~8 citation/usage keys per sync = ~32/day. Total ~90/day against
 *   1,000. Adding a category costs 8 writes/day. There is room for roughly
 *   100 categories before this becomes the binding constraint.
 */

import { composite, normalise, quotaSufficiency, estimateCalls, DEFAULT_WEIGHTS, type Weights } from './scoring';

export const TIERS = ['free', 'all'] as const;
export type Tier = (typeof TIERS)[number];

export interface RankedOffering {
  model_id: string;
  harness_id: string;
  plan_id: string;
  medium: string;
  context_window: number | null;
  is_free: boolean;
  access_url: string | null;
  score: number;
  /** Which scoring terms contributed. Rendered as provenance in the UI. */
  basis: string[];
  /** 'harness_measured' | 'model_only_inferred' */
  score_scope: string;
  raw_benchmark_value: number | null;
  /** Normalised quality, retained so the request path can re-rank against the
   *  user's actual size hint without touching D1 or re-normalising. */
  quality_norm: number | null;
  /** Community usage: total tokens for this model in the trailing window,
   *  from openrouter.ai/rankings daily totals. Null when the model has no
   *  usage rows — no signal, not a fabricated zero. */
  usage_tokens: number | null;
  /** `usage_share` normalised 0–100 across the candidate set. Swapped in for
   *  `quality_norm` when the user asks for quality = "community usage". */
  usage_norm: number | null;
  /** H term from Terminal-Bench for this (model, harness), or null. */
  harness_norm: number | null;
  benchmark: string;
  quota_unit: string | null;
  quota_value: number | null;
  quota_confidence: string | null;
  /** True when this allowance is shared with every model on the platform. */
  quota_shared?: boolean;
  /** A higher tier the user could unlock, if any. */
  quota_conditional?: number | null;
  quota_condition_key?: string | null;
}

export interface AnswerBlob {
  category: string;
  tier: Tier;
  benchmark: string;
  as_of: string;
  /** Attribution string from upstream, rendered verbatim. */
  citation: string | null;
  /** Attribution for the usage (share-of-spend) quality source. */
  usage_citation: string | null;
  /** Date of the usage dataset, for share-of-spend ranking. */
  usage_as_of: string | null;
  offerings: RankedOffering[];
}

interface OfferingRow {
  model_id: string;
  score_key: string | null;
  harness_id: string;
  plan_id: string;
  medium: string;
  context_window: number | null;
  is_free: number;
  access_url: string | null;
  quota_unit: string | null;
  quota_value: number | null;
  quota_confidence: string | null;
  bench_value: number | null;
  bench_as_of: string | null;
  harness_norm: number | null;
  pool_unit: string | null;
  pool_value: number | null;
  pool_conditional: number | null;
  pool_condition: string | null;
  pool_shared: number | null;
  pool_confidence: string | null;
  usage_tokens: number | null;
}

/** Trailing window for the community usage signal, matching the "Share of
 *  Spend" 7-day view the rankings page uses. Ingested rows span the 7 most
 *  recent completed UTC days; the rank query starts at the same cut. */
const USAGE_WINDOW_DAYS = 7;

const MAX_OFFERINGS_PER_BLOB = 25;

export function answerKey(category: string, tier: Tier): string {
  return `answer:${category}:${tier}`;
}

/** Resolve the benchmark for a category, honouring a user override. */
export async function benchmarkForCategory(db: D1Database, category: string): Promise<string | null> {
  const row = await db
    .prepare(`SELECT default_benchmark, user_override FROM category_benchmarks WHERE category = ?1`)
    .bind(category)
    .first<{ default_benchmark: string; user_override: string | null }>();
  if (!row) return null;
  return row.user_override ?? row.default_benchmark;
}

/**
 * Compute and persist one (category, tier) blob.
 *
 * Kept to a single pair per invocation so the CPU cost stays bounded — the same
 * discipline as the ingest slices.
 */
export async function computeAndStore(
  db: D1Database,
  kv: KVNamespace,
  category: string,
  tier: Tier,
  weights: Weights = DEFAULT_WEIGHTS,
): Promise<{ key: string; count: number } | null> {
  const benchmark = await benchmarkForCategory(db, category);
  if (!benchmark) return null;

  // Join offerings to their score for this benchmark. LEFT JOIN so an offering
  // with no score still appears and is filtered explicitly below, rather than
  // vanishing silently.
  //
  // The score and harness joins use score_key on BOTH sides. The benchmark
  // API keys some models on dated build slugs
  // (`nvidia/nemotron-3-super-120b-a12b-20230311`) while the catalog lists the
  // same model undated, and free variants carry `:free` — `scores.score_key`
  // and `offerings.score_key` normalise all three shapes to one base slug, so
  // a free variant inherits the base model's benchmark exactly as it inherits
  // its usage. Rows are deduped by model_id in JS: multiple dated builds of
  // one model collapse to a single score_key, and the ORDER BY keeps the best
  // value first.
  // Same trailing window as ingest: the 7 most recent completed UTC days.
  // Usage rows older than the window still sit in D1 (they are keyed by date)
  // but stop contributing, so the share rolls forward naturally.
  const usageWindow = new Date(Date.now() - USAGE_WINDOW_DAYS * 864e5)
    .toISOString()
    .slice(0, 10);
  const sql = `
    SELECT o.model_id, o.score_key, o.harness_id, o.plan_id, o.medium, o.context_window,
           o.is_free, o.access_url, o.quota_unit, o.quota_value, o.quota_confidence,
           s.value AS bench_value, s.as_of AS bench_as_of,
           -- The harness term comes from a DIFFERENT row: a Terminal-Bench
           -- score measured for this exact (model, harness) pair. Its
           -- normalised column is the H value computed in terminalbench.ts.
           h.normalised AS harness_norm,
           -- Quota comes from the POOL, not the offering: on OpenRouter every
           -- :free model draws from one globally-governed bucket.
           p.quota_unit AS pool_unit, p.quota_value AS pool_value,
           p.conditional_value AS pool_conditional, p.condition_key AS pool_condition,
           p.is_shared AS pool_shared, p.confidence AS pool_confidence,
           -- Community usage: tokens for this model in the trailing window.
           -- Joins by score_key too, so a free variant inherits the base
           -- row's usage exactly as it inherits its benchmark.
           u.total_tokens AS usage_tokens
      FROM offerings o
      LEFT JOIN scores s
        ON s.score_key = COALESCE(o.score_key, o.model_id)
       AND s.benchmark = ?1
       AND s.harness_id = ''
      LEFT JOIN scores h
        ON h.score_key = COALESCE(o.score_key, o.model_id)
       AND h.harness_id = o.harness_id
       AND h.source = 'terminal-bench'
       AND h.score_scope = 'harness_measured'
      LEFT JOIN quota_pools p ON p.pool_id = o.pool_id
      LEFT JOIN (
        SELECT score_key, SUM(total_tokens) AS total_tokens
          FROM usage_rankings
         WHERE date >= ?2
         GROUP BY score_key
      ) u ON u.score_key = COALESCE(o.score_key, o.model_id)
     ${tier === 'free' ? 'WHERE o.is_free = 1' : ''}
     ORDER BY s.value DESC
     LIMIT 200`;

  const { results } = await db.prepare(sql).bind(benchmark, usageWindow).all<OfferingRow>();
  const seen = new Set<string>();
  const rows = (results ?? [])
    .filter((r) => r.bench_value !== null)
    .filter((r) => {
      if (seen.has(r.model_id)) return false;
      seen.add(r.model_id);
      return true;
    });
  if (rows.length === 0) {
    // Write an empty blob rather than leaving a stale one in place.
    const empty: AnswerBlob = {
      category, tier, benchmark,
      as_of: new Date().toISOString(),
      citation: await kv.get('citation:artificial-analysis'),
      usage_citation: await kv.get('citation:rankings-daily'),
      usage_as_of: null,
      offerings: [],
    };
    await kv.put(answerKey(category, tier), JSON.stringify(empty));
    return { key: answerKey(category, tier), count: 0 };
  }

  // Pass the benchmark so known-scale indices normalise absolutely rather
  // than against whatever candidates happen to be present.
  const qualityNorm = normalise(rows.map((r) => r.bench_value), benchmark);

  // The community usage share, normalised across THIS candidate set. There is
  // no known scale for "share of spend", so min-max applies — the same reason
  // Design Arena ELO min-maxes within its set. A model with no usage rows gets
  // a null term, exactly as a benchmark-less row does.
  const usageNorm = normalise(rows.map((r) => r.usage_tokens), 'da_share_of_spend');

  // Quota sufficiency assumes a medium-sized task at ranking time. The request
  // path re-ranks against the user's actual size hint when it differs.
  const estCalls = estimateCalls('medium');

  const scored: RankedOffering[] = rows.map((r, i) => {
    // Pool first, falling back to any per-offering override.
    const quotaValue = r.pool_value ?? r.quota_value;
    const quotaUnit = r.pool_unit ?? r.quota_unit;
    const quota = quotaSufficiency(quotaValue, quotaUnit, estCalls);

    // H comes from Terminal-Bench, measured for this exact (model, harness)
    // pair. Null where no such measurement exists — the weight then
    // redistributes rather than being faked from the model-level score.
    const harness = r.harness_norm;

    const { score, basis } = composite(
      { quality: qualityNorm[i], harness, quota, speed: null },
      weights,
    );

    return {
      model_id: r.model_id,
      harness_id: r.harness_id,
      plan_id: r.plan_id,
      medium: r.medium,
      context_window: r.context_window,
      is_free: r.is_free === 1,
      access_url: r.access_url,
      score: Math.round(score * 100) / 100,
      basis,
      score_scope: r.harness_norm !== null ? 'harness_measured' : 'model_only_inferred',
      raw_benchmark_value: r.bench_value,
      quality_norm: qualityNorm[i],
      usage_tokens: r.usage_tokens,
      usage_norm: usageNorm[i],
      harness_norm: r.harness_norm,
      benchmark,
      quota_unit: quotaUnit,
      quota_value: quotaValue,
      quota_confidence: r.pool_confidence ?? r.quota_confidence,
      quota_shared: r.pool_shared === 1,
      quota_conditional: r.pool_conditional,
      quota_condition_key: r.pool_condition,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, MAX_OFFERINGS_PER_BLOB);

  const blob: AnswerBlob = {
    category,
    tier,
    benchmark,
    as_of: rows[0].bench_as_of ?? new Date().toISOString(),
    citation: await kv.get('citation:artificial-analysis'),
    usage_citation: await kv.get('citation:rankings-daily'),
    usage_as_of: rows[0].usage_tokens === null
      ? null
      : (await kv.get('usage-as-of')) ?? new Date().toISOString(),
    offerings: top,
  };

  await kv.put(answerKey(category, tier), JSON.stringify(blob));
  await snapshotRanks(db, category, tier, top);

  return { key: answerKey(category, tier), count: top.length };
}

/** Persist the top 3 for change detection. Keeping only 3 bounds D1 growth. */
async function snapshotRanks(
  db: D1Database,
  category: string,
  tier: Tier,
  ranked: RankedOffering[],
): Promise<void> {
  if (ranked.length === 0) return;
  const capturedAt = new Date().toISOString();

  const stmt = db.prepare(
    `INSERT OR REPLACE INTO rank_history
       (category, tier, rank, model_id, harness_id, plan_id, score, captured_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`,
  );

  await db.batch(
    ranked.slice(0, 3).map((o, i) =>
      stmt.bind(category, tier, i + 1, o.model_id, o.harness_id, o.plan_id, o.score, capturedAt),
    ),
  );
}

/**
 * Detect a change at rank 1 since the previous capture.
 * Fires only when the margin also exceeds the threshold, which suppresses churn
 * between near-tied models.
 */
export async function detectRankOneChange(
  db: D1Database,
  category: string,
  tier: Tier,
  thresholdPct: number,
): Promise<{ changed: boolean; current?: string; previous?: string; margin?: number }> {
  const { results } = await db
    .prepare(
      `SELECT model_id, harness_id, score, captured_at
         FROM rank_history
        WHERE category = ?1 AND tier = ?2 AND rank = 1
        ORDER BY captured_at DESC
        LIMIT 2`,
    )
    .bind(category, tier)
    .all<{ model_id: string; harness_id: string; score: number; captured_at: string }>();

  if (!results || results.length < 2) return { changed: false };

  const [current, previous] = results;
  const sameOffering =
    current.model_id === previous.model_id && current.harness_id === previous.harness_id;
  if (sameOffering) return { changed: false };

  const margin = previous.score === 0 ? 100 : ((current.score - previous.score) / previous.score) * 100;
  if (Math.abs(margin) < thresholdPct) return { changed: false };

  return {
    changed: true,
    current: `${current.model_id} via ${current.harness_id}`,
    previous: `${previous.model_id} via ${previous.harness_id}`,
    margin: Math.round(margin * 10) / 10,
  };
}
