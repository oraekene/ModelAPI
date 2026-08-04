/**
 * Scoring — §6 of the v2 spec.
 *
 *   Score = w_quality × Q + w_harness × H + w_quota × K + w_speed × V
 *
 * The important design decision here is what happens when a term has no data.
 *
 * Stubbing a missing term to full marks (K = 100 for every offering) is wrong:
 * it silently awards points on a dimension that is supposed to discriminate,
 * and it shifts the effective weight of every other term without saying so.
 *
 * Instead, missing terms are DROPPED and the remaining weights are
 * renormalised to sum to 1. The score then means "the best answer given what
 * we actually measured", and the set of contributing terms is reported
 * alongside it so the UI can be honest about the basis.
 *
 * When the quota scrapers land (step 7), K starts contributing automatically —
 * no formula change, no reweighting by hand.
 */

export interface Weights {
  quality: number;
  harness: number;
  quota: number;
  speed: number;
}

export const DEFAULT_WEIGHTS: Weights = {
  quality: 0.55,
  harness: 0.20,
  quota: 0.15,
  speed: 0.10,
};

export interface ScoreInputs {
  /** Normalised benchmark score for the category, 0–100. Required. */
  quality: number | null;
  /** Harness delta, 0–100, or null when no harness-measured score exists. */
  harness: number | null;
  /** Quota sufficiency, 0–100, or null when quota is unknown. */
  quota: number | null;
  /** Normalised throughput, 0–100, or null when unmeasured. */
  speed: number | null;
}

export interface ScoreResult {
  score: number;
  /** Which terms actually contributed. Surfaced in the UI. */
  basis: Array<keyof Weights>;
  /** Weights after renormalisation, for debugging and display. */
  effectiveWeights: Partial<Weights>;
}

export function composite(inputs: ScoreInputs, weights: Weights = DEFAULT_WEIGHTS): ScoreResult {
  const terms: Array<[keyof Weights, number]> = [];

  if (inputs.quality !== null) terms.push(['quality', inputs.quality]);
  if (inputs.harness !== null) terms.push(['harness', inputs.harness]);
  if (inputs.quota !== null) terms.push(['quota', inputs.quota]);
  if (inputs.speed !== null) terms.push(['speed', inputs.speed]);

  if (terms.length === 0) {
    return { score: 0, basis: [], effectiveWeights: {} };
  }

  const weightSum = terms.reduce((acc, [k]) => acc + weights[k], 0);
  if (weightSum <= 0) {
    return { score: 0, basis: [], effectiveWeights: {} };
  }

  let score = 0;
  const effectiveWeights: Partial<Weights> = {};
  for (const [k, v] of terms) {
    const w = weights[k] / weightSum;
    effectiveWeights[k] = w;
    score += w * v;
  }

  return { score, basis: terms.map(([k]) => k), effectiveWeights };
}

/**
 * Natural ranges for benchmarks whose scale is known a priori.
 *
 * Where a benchmark has a fixed scale, normalising against THAT is correct.
 * Min-max against the candidate set is not: it stretches whatever spread
 * happens to be present to fill 0–100, so two models three points apart on a
 * 0–100 index look 100 points apart if they are the only two candidates. The
 * bottom candidate always scoring zero is the same bug seen from the other end.
 */
const BENCHMARK_SCALES: Record<string, [number, number]> = {
  aa_intelligence_index: [0, 100],
  aa_coding_index: [0, 100],
  aa_agentic_index: [0, 100],
  terminal_bench_2_0: [0, 1],
  terminal_bench_2_1: [0, 1],
};

/** Below this, a candidate set is too small for min-max to mean anything. */
const MIN_CANDIDATES_FOR_MINMAX = 5;

/**
 * Normalise raw benchmark values to 0–100.
 *
 * Three cases, in order of preference:
 *
 *  1. Known scale (AA indices, Terminal-Bench) — normalise against the true
 *     range. Absolute and stable: a model's score does not change because a
 *     different set of competitors was in the query.
 *  2. Unknown scale with enough candidates (Design Arena ELO) — min-max within
 *     the set. Relative, but with enough samples the spread is meaningful.
 *  3. Unknown scale, too few candidates — return 50 for everything, letting the
 *     other scoring terms decide. Refusing to rank is better than inventing a
 *     100-point gap from three ELO points.
 *
 * A flat field also returns 50 rather than 0 — no spread should not read as
 * uniformly bad.
 */
export function normalise(
  values: Array<number | null>,
  benchmark?: string,
): Array<number | null> {
  const present = values.filter((v): v is number => v !== null);
  if (present.length === 0) return values.map(() => null);

  const knownScale = benchmark ? BENCHMARK_SCALES[benchmark] : undefined;

  if (knownScale) {
    const [lo, hi] = knownScale;
    const span = hi - lo;
    return values.map((v) =>
      v === null ? null : Math.max(0, Math.min(100, ((v - lo) / span) * 100)),
    );
  }

  if (present.length < MIN_CANDIDATES_FOR_MINMAX) {
    return values.map((v) => (v === null ? null : 50));
  }

  const min = Math.min(...present);
  const max = Math.max(...present);
  const spread = max - min;
  if (spread === 0) return values.map((v) => (v === null ? null : 50));

  return values.map((v) => (v === null ? null : ((v - min) / spread) * 100));
}

/**
 * Quota sufficiency, 0–100.
 *
 * The term v1 lacked and the one that matters most for free tiers: a top-ranked
 * model capped at 50 calls/day is worse for a real working session than a
 * fourth-ranked one with 1,000. Saturates at 100 — having ten times the quota
 * you need is not better than having twice.
 *
 * Returns null when quota is unknown, so the term drops out rather than
 * guessing.
 */
export function quotaSufficiency(
  quotaValue: number | null | undefined,
  quotaUnit: string | null | undefined,
  estCallsNeeded: number,
): number | null {
  if (quotaValue == null || quotaUnit == null || estCallsNeeded <= 0) return null;

  const perSession = toCallsPerSession(quotaValue, quotaUnit);
  if (perSession === null) return null;

  return Math.min(1, perSession / estCallsNeeded) * 100;
}

/**
 * Convert a vendor quota into comparable "calls available in one working
 * session". A session is treated as ~4 hours of active work.
 */
function toCallsPerSession(value: number, unit: string): number | null {
  switch (unit) {
    case 'requests_per_day':
      return value / 2;          // ~2 sessions per day
    case 'requests_per_hour':
      return value * 4;
    case 'messages_per_5h':
      return value;              // already ~one session
    case 'requests_per_minute':
      return value * 60;         // effectively unconstrained for our purposes
    case 'tokens_per_day':
      return value / 4000 / 2;   // ~4k tokens per call
    case 'unlimited':
      return Number.MAX_SAFE_INTEGER;
    default:
      return null;
  }
}

/** Rough call-count estimates by task shape. Feeds quotaSufficiency. */
export function estimateCalls(sizeHint: 'small' | 'medium' | 'large' | 'agent'): number {
  switch (sizeHint) {
    case 'small':  return 3;
    case 'medium': return 30;
    case 'large':  return 80;
    case 'agent':  return 150;
  }
}
