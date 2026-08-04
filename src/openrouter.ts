/**
 * OpenRouter API client — step 3.
 *
 * Every upstream call is made here and only here. The rest of the codebase
 * deals with typed results, never raw JSON, so a schema change in the API
 * surfaces as a type error in one file instead of a silent wrong value in
 * rankings.
 *
 * RATE LIMITS: the Data API shares 30 req/min per key and 500 req/day per
 * account across all endpoints. That is why no user request path calls these
 * functions — only the cron/queue pipeline does.
 */

const API = 'https://openrouter.ai/api/v1';

// ---------------------------------------------------------------------------
// Models catalog
// ---------------------------------------------------------------------------

export interface ORModel {
  id: string;
  name: string;
  context_length?: number | null;
  pricing?: {
    prompt?: string | number | null;
    completion?: string | number | null;
    request?: string | number | null;
    image?: string | number | null;
  } | null;
  modalities?: {
    input?: Array<string | { type?: string }>;
    output?: Array<string | { type?: string }>;
  } | null;
  supported_parameters?: string[] | null;
  provider?: { source?: string | null } | null;
  [key: string]: unknown;
}

export interface ORModelsResponse {
  data: ORModel[];
}

/**
 * Fetch the full model catalog. One call per sync; the payload is split into
 * queue slices by the producer so parsing never happens inside the cron.
 */
export async function listModels(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ORModelsResponse> {
  const res = await fetchImpl(`${API}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`openrouter /models: HTTP ${res.status}`);
  return (await res.json()) as ORModelsResponse;
}

// ---------------------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------------------

/**
 * One item from the unified /benchmarks endpoint. Which fields are populated
 * depends on the source: Artificial Analysis items carry the three composite
 * indices; Design Arena items carry an ELO. The `citation` field carries the
 * required attribution string verbatim.
 */
export interface BenchmarkItem {
  model_permaslug: string;
  display_name: string;
  pricing?: { prompt?: string | number | null; completion?: string | number | null } | null;
  intelligence_index?: number | null;
  coding_index?: number | null;
  agentic_index?: number | null;
  elo?: number | null;
  category?: string | null;
  [key: string]: unknown;
}

export interface BenchmarksMeta {
  as_of?: string;
  citation?: string | null;
  version?: string | null;
}

export interface BenchmarksResponse {
  data: BenchmarkItem[];
  meta?: BenchmarksMeta;
}

/**
 * Unified benchmark scores, aggregated by OpenRouter from multiple sources and
 * already keyed on OpenRouter model identity — which is exactly the join the
 * v2 spec's fuzzy slug-matching layer existed to do, and is why that layer was
 * deleted.
 *
 * `source` selectors: 'artificial-analysis' | 'design-arena'. `category` maps
 * to the endpoint's category filter (e.g. 'coding' for AA, 'dataviz' /
 * 'uicomponent' / 'gamedev' / 'svg' for Design Arena).
 */
export async function listBenchmarks(
  apiKey: string,
  opts: { source: 'artificial-analysis' | 'design-arena'; category?: string; maxResults?: number },
  fetchImpl: typeof fetch = fetch,
): Promise<BenchmarksResponse> {
  const url = new URL(`${API}/benchmarks`);
  url.searchParams.set('source', opts.source);
  if (opts.category) url.searchParams.set('category', opts.category);
  url.searchParams.set('max_results', String(opts.maxResults ?? 500));

  const res = await fetchImpl(url.toString(), {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`openrouter /benchmarks: HTTP ${res.status}`);
  return (await res.json()) as BenchmarksResponse;
}

// ---------------------------------------------------------------------------
// Usage rankings (daily token totals)
// ---------------------------------------------------------------------------

/**
 * One row from GET /api/v1/datasets/rankings-daily.
 * `total_tokens` is a decimal STRING so 64-bit totals are not truncated by the
 * JSON parser — parse with Number() at ingest.
 */
export interface RankingsDailyItem {
  date: string;
  model_permaslug: string;
  total_tokens: string;
}

export interface RankingsDailyMeta {
  as_of?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  version?: string | null;
}

export interface RankingsDailyResponse {
  data: RankingsDailyItem[];
  meta?: RankingsDailyMeta;
}

/**
 * Top-50 token totals per day, the dataset behind the public rankings chart at
 * openrouter.ai/rankings. Free variants are ranked as their own rows (the
 * `:free` suffix is the variant, exactly as in the catalog). Each day closes
 * with a reserved `other` row summing the long tail; it pin ensures
 * top-50/total can be computed without a second call.
 *
 * Attribution (required verbatim): "Source: OpenRouter (openrouter.ai/rankings),
 * as of {as_of}."
 */
export async function fetchRankingsDaily(
  apiKey: string,
  opts: { startDate?: string; endDate?: string } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<RankingsDailyResponse> {
  const url = new URL(`${API}/datasets/rankings-daily`);
  if (opts.startDate) url.searchParams.set('start_date', opts.startDate);
  if (opts.endDate) url.searchParams.set('end_date', opts.endDate);

  const res = await fetchImpl(url.toString(), {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`openrouter /datasets/rankings-daily: HTTP ${res.status}`);
  return (await res.json()) as RankingsDailyResponse;
}

// ---------------------------------------------------------------------------
// Model predicates
// ---------------------------------------------------------------------------

/**
 * Free variant detection: OpenRouter marks free models with a `:free` suffix
 * on the slug. A model-only free by some providers and paid by others can
 * appear as both `id` and `id:free`; the suffix is the variant, not a
 * nickname.
 */
export function isFree(m: Pick<ORModel, 'id'>): boolean {
  return /:[a-z0-9]*(free|7b-lite)$/i.test(m.id) || /:free/i.test(m.id);
}

/**
 * The slug variants share as a base: strip a trailing `:variant`, leaving the
 * base permaslug. `openai/gpt-oss-20b:free` -> `openai/gpt-oss-20b`.
 *
 * A trailing compact date stamp (`-20230311`) is stripped too: the usage
 * dataset keys some free variants with their build date while the catalog
 * lists the same model undated, so `nvidia/nemotron-3-super-120b-a12b-
 * 20230311:free` must resolve to `nvidia/nemotron-3-super-120b-a12b` or its
 * usage never reaches the offering.
 *
 * Benchmark scores are keyed on base slugs, so this is the join key between
 * an offering and its score. Dash-separated dates (`gpt-4o-2024-05-13`) are
 * left intact — they are the canonical identity, not a build stamp.
 */
export function baseSlug(id: string): string {
  const colon = id.lastIndexOf(':');
  const base = colon > 0 ? id.slice(0, colon) : id;
  return base.replace(/-\d{8}$/, '');
}

/** Modal support, inferred from the 2026-style `modalities.input` array. */
export function supportsVision(m: ORModel): boolean {
  const input = m.modalities?.input;
  if (!Array.isArray(input)) return false;
  return input.some((i) => {
    const t = typeof i === 'string' ? i : i?.type;
    return typeof t === 'string' && /image|vision/i.test(t);
  });
}

/** Tool-calling support, from the `supported_parameters` array. */
export function supportsTools(m: ORModel): boolean {
  const params = m.supported_parameters;
  if (!Array.isArray(params)) return false;
  return params.some((p) => /tools?|function|call/i.test(String(p)));
}