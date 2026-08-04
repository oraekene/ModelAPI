/**
 * Request path — §8 of the v2 spec.
 *
 * Hard rules: exactly ONE KV read, ZERO upstream API calls, well under 10 ms CPU.
 * Everything expensive already happened in the cron/queue pipeline.
 */

import { classify, SIZE_TOKENS, type Classification } from './classify';
import { selectMedium, fitsContext, mediumLabel, type Medium, type MediumDecision } from './medium';
import { composite, quotaSufficiency, estimateCalls, DEFAULT_WEIGHTS } from './scoring';
import { answerKey, type AnswerBlob, type RankedOffering } from './ranking';

export interface RecommendRequest {
  task: string;
  tier: 'free' | 'all';
  size: 'small' | 'medium' | 'large' | 'agent';
  /** Quality source for the board. `benchmark` = AA/Design Arena indices;
   *  `share` = community token usage (openrouter.ai/rankings). */
  quality: 'benchmark' | 'share';
  needsExecution: boolean;
  needsFileWrites: boolean;
  limit?: number;
}

export interface RecommendResponse {
  classification: Classification;
  medium: MediumDecision & { assigned: Medium; assignedLabel: string };
  benchmark: string | null;
  as_of: string | null;
  citation: string | null;
  /** Which quality source ranked the board. */
  quality: 'benchmark' | 'share';
  results: RankedOffering[];
  /** Present when the task was ambiguous and a second category was also read. */
  alternateResults?: { category: string; results: RankedOffering[] };
  notice?: string;
  /** Shown once, not per row: a higher quota tier the user could unlock. */
  upgradeHint?: string;
}

export function parseRequest(url: URL): RecommendRequest {
  const size = (url.searchParams.get('size') ?? 'medium') as RecommendRequest['size'];
  const quality = url.searchParams.get('quality') as RecommendRequest['quality'] | null;
  return {
    task: url.searchParams.get('task') ?? '',
    tier: (url.searchParams.get('tier') ?? 'free') as 'free' | 'all',
    size: ['small', 'medium', 'large', 'agent'].includes(size) ? size : 'medium',
    quality: quality === 'share' ? 'share' : 'benchmark',
    needsExecution: url.searchParams.get('exec') === '1',
    needsFileWrites: url.searchParams.get('files') === '1',
    limit: Math.min(10, Number(url.searchParams.get('limit') ?? 5)),
  };
}

export async function recommend(
  kv: KVNamespace,
  req: RecommendRequest,
  userFlags: Record<string, boolean> = {},
): Promise<RecommendResponse> {
  const classification = classify(req.task);
  const estTokens = SIZE_TOKENS[req.size] ?? SIZE_TOKENS.medium;

  const mediumDecision = selectMedium({
    needsExecution: req.needsExecution,
    needsFileWrites: req.needsFileWrites,
    estTokens,
  });

  // THE single KV read.
  const raw = await kv.get(answerKey(classification.category, req.tier));

  if (!raw) {
    return {
      classification,
      medium: { ...mediumDecision, assigned: mediumDecision.allowed[0], assignedLabel: mediumLabel(mediumDecision.allowed[0]) },
      benchmark: null,
      as_of: null,
      citation: null,
      quality: req.quality,
      results: [],
      notice: `No ranking computed yet for ${classification.category}. Run a sync first.`,
    };
  }

  const blob = JSON.parse(raw) as AnswerBlob;
  const ranked = rerank(blob.offerings, req, estTokens, mediumDecision.allowed, userFlags);

  // The medium actually assigned is whichever the winning offering serves.
  const assigned = (ranked[0]?.medium as Medium) ?? mediumDecision.allowed[0];

  return {
    classification,
    medium: { ...mediumDecision, assigned, assignedLabel: mediumLabel(assigned) },
    benchmark: blob.benchmark,
    // The citation follows the quality source the user chose: benchmark rows
    // credit the benchmark aggregator, share rows credit the rankings page.
    citation: req.quality === 'share' ? blob.usage_citation ?? blob.citation : blob.citation,
    as_of: req.quality === 'share' ? blob.usage_as_of ?? blob.as_of : blob.as_of,
    quality: req.quality,
    results: ranked.slice(0, req.limit ?? 5),
    upgradeHint: buildUpgradeHint(ranked, userFlags),
    notice: ranked.length === 0
      ? 'Every candidate was filtered out — try a smaller size or switch off free-only.'
      : undefined,
  };
}

/**
 * The pool's conditional tier, applied when THIS user has met its condition.
 *
 * Without this, the personalisation the pools exist to deliver never happens:
 * the blob is computed once with the baseline allowance, and every visitor
 * would read the same 50/day even if their account is on the 1000/day tier.
 */
function resolveQuotaValue(
  o: RankedOffering,
  flags: Record<string, boolean>,
): { value: number | null; conditionalUsed: boolean } {
  const cond = o.quota_conditional;
  if (
    o.quota_condition_key &&
    cond != null &&
    cond > 0 &&
    o.quota_value != null &&
    flags[o.quota_condition_key] === true
  ) {
    return { value: cond, conditionalUsed: true };
  }
  return { value: o.quota_value, conditionalUsed: false };
}

/**
 * A pool-level upgrade the user has not taken, surfaced once rather than on
 * every row. The OpenRouter case is a twentyfold daily increase for a one-off
 * $10 purchase, which is more actionable than any model swap the board could
 * suggest.
 */
function buildUpgradeHint(ranked: RankedOffering[], flags: Record<string, boolean>): string | undefined {
  const top = ranked[0];
  if (!top?.quota_conditional || top.quota_value == null) return undefined;
  if (top.quota_conditional <= top.quota_value) return undefined;
  if (top.quota_condition_key && flags[top.quota_condition_key] === true) return undefined;
  const unit = (top.quota_unit ?? '').replace(/_/g, ' ');
  const factor = Math.round(top.quota_conditional / top.quota_value);
  return `This allowance rises to ${top.quota_conditional} ${unit} (${factor}x) once the platform's paid-credit threshold is met.`;
}

/**
 * Filter by medium and context fit, then re-score against the user's ACTUAL
 * size hint.
 *
 * The stored blob was ranked assuming a medium-sized task. A user asking about
 * a 150-call agent run has a different quota picture than one asking a single
 * question, and quota sufficiency is the term that captures it. Recomputing is
 * cheap because `quality_norm` was retained at rank time — no re-normalising,
 * no D1.
 */
function rerank(
  offerings: RankedOffering[],
  req: RecommendRequest,
  estTokens: number,
  allowedMediums: Medium[],
  userFlags: Record<string, boolean>,
): RankedOffering[] {
  const estCalls = estimateCalls(req.size);
  const allowed = new Set<string>(allowedMediums);

  const out: RankedOffering[] = [];
  for (const o of offerings) {
    // 'api' offerings are reachable from any medium — the OpenRouter API row
    // stands in for "use this model directly" until real harness rows exist.
    if (o.medium !== 'api' && !allowed.has(o.medium)) continue;
    if (!fitsContext(o.context_window, estTokens)) continue;

    const { value: quotaValue } = resolveQuotaValue(o, userFlags);
    const quota = quotaSufficiency(quotaValue, o.quota_unit, estCalls);
    const harness = o.harness_norm;
    // The Q term depends on the board's quality source. `share` ranks by what
    // the OpenRouter community actually talks to — the alternative signal the
    // pool this request sits in exists to surface.
    const quality = req.quality === 'share' ? o.usage_norm : o.quality_norm;
    const { score, basis } = composite(
      { quality, harness, quota, speed: null },
      DEFAULT_WEIGHTS,
    );

    out.push({ ...o, quota_value: quotaValue, score: Math.round(score * 100) / 100, basis });
  }

  out.sort((a, b) => b.score - a.score);
  return out;
}
