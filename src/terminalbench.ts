/**
 * Terminal-Bench ingestion — step 6.
 *
 * This is the source that makes `score_scope = 'harness_measured'` real. It is
 * the only public dataset that scores a MODEL AND ITS HARNESS TOGETHER, which
 * is the distinction the whole `offerings` schema exists to capture.
 *
 * BUDGET FINDING: the 2.0 leaderboard is fully server-rendered — all ~142
 * entries arrive through a plain fetch(), so this costs ZERO Browser Rendering
 * time. 2.1 is partially client-rendered: only the top 17 entries come down
 * with the HTML and the rest load via JS, so 2.1 contributes a top-17 snapshot.
 * Neither case touches the 10 min/day allowance.
 *
 * COVERAGE LIMIT, stated plainly: terminal/CLI agents only. There is no
 * equivalent public dataset for Cursor, Cline, or chat interfaces. Those stay
 * `model_only_inferred` and the UI says so.
 */

import { baseSlug } from './openrouter';

const LEADERBOARDS = [
  { version: '2.0', url: 'https://www.tbench.ai/leaderboard/terminal-bench/2.0', benchmark: 'terminal_bench_2_0' },
  { version: '2.1', url: 'https://www.tbench.ai/leaderboard/terminal-bench/2.1', benchmark: 'terminal_bench_2_1' },
];

export interface TBEntry {
  rank: number;
  agent: string;      // the harness
  model: string;      // display name, NOT an OpenRouter slug
  date: string;
  agentOrg: string;
  modelOrg: string;
  accuracy: number;   // 0–1
}

/**
 * Parse the leaderboard table out of the rendered page.
 *
 * Cell order is NOT relied on: the 2.0 board renders
 * [checkbox, rank, agent, model, date, agentOrg, modelOrg, accuracy] while the
 * 2.1 board inserts an `Effort` column and a `PR` column, shifting everything.
 * So cells are identified by CONTENT instead: the rank is the first purely
 * numeric cell, the accuracy is the cell carrying a percentage, and the agent
 * and model are the two cells right after the rank.
 *
 * Deliberately tolerant: unparseable rows are skipped rather than throwing, but
 * the caller checks the total and fails loudly if it collapses. A silent drop
 * to zero rows would leave stale harness deltas in place, which is worse than
 * no harness data at all.
 */
export function parseLeaderboard(html: string): TBEntry[] {
  const entries: TBEntry[] = [];

  // Rows are <tr> with cells; each cell is a <td> (or <th>). Tag-stripping a
  // cell keeps this resilient to the link and badge markup that wraps fields.
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;

  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(html)) !== null) {
    const cells: string[] = [];
    let cellMatch: RegExpExecArray | null;
    cellRe.lastIndex = 0;
    while ((cellMatch = cellRe.exec(rowMatch[1])) !== null) {
      cells.push(stripTags(cellMatch[1]));
    }
    if (cells.length < 4) continue;

    // Rank: the first purely numeric cell. Accuracy: the cell with a percentage.
    const rankIdx = cells.findIndex((c) => /^\d+$/.test(c));
    const pctIdx = cells.findIndex((c) => /(-?\d+(?:\.\d+)?)\s*%/.test(c));
    if (rankIdx === -1 || pctIdx === -1) continue;

    // Agent sits immediately after the rank, the model after that. Date/orgs
    // are cosmetic and their position differs between board schemas, so pick
    // whichever of the neighbouring cells is non-empty.
    const agent = cells[rankIdx + 1];
    const model = cells[rankIdx + 2];
    if (!agent || !model) continue;

    const pct = /(-?\d+(?:\.\d+)?)\s*%/.exec(cells[pctIdx]);
    if (!pct) continue;

    const next = (d1: number, d2: number) => cells[pctIdx + d1] || cells[pctIdx + d2] || '';

    entries.push({
      rank: Number(cells[rankIdx]),
      agent: agent.trim(),
      model: model.trim(),
      date: next(-3, 1),
      agentOrg: next(-2, 2),
      modelOrg: next(-1, 3),
      accuracy: Number(pct[1]) / 100,
    });
  }

  return entries;
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Rows whose model is an aggregate rather than a specific model.
 *
 * Several harnesses submit under "Multiple" — they route across models
 * internally. Those results are real but cannot be attributed to any single
 * model, so they are dropped rather than guessed at.
 */
const AGGREGATE_MODEL_NAMES = new Set(['multiple', 'various', 'mixed', 'n/a']);

export function isAttributable(e: TBEntry): boolean {
  return !AGGREGATE_MODEL_NAMES.has(e.model.toLowerCase().trim());
}

// ---------------------------------------------------------------------------
// Model name matching
// ---------------------------------------------------------------------------

/**
 * The hard part of this step. Terminal-Bench publishes DISPLAY names
 * ("Claude Opus 4.6", "GPT-5.3-Codex", "Claude 4.6 Opus") while OpenRouter uses
 * slugs ("anthropic/claude-opus-4.6"). The real data contains token reordering
 * ("Claude 4.6 Opus" vs "Claude Opus 4.6"), case and separator variants
 * ("minimax-m2.5" / "Minimax m2.5" / "MiniMax M2.5"), and adjacent versions
 * that must NOT be conflated.
 *
 * Strategy: compare as token SETS so ordering does not matter, but require the
 * VERSION to match exactly. Version equality is the guard that stops Opus 4.5
 * from matching Opus 4.6 — a mistake that would silently attribute one model's
 * harness score to another.
 */
export interface NameParts {
  tokens: Set<string>;
  versions: string[];
}

const NOISE_TOKENS = new Set(['ai', 'the', 'model', 'instruct', 'preview', 'latest']);

export function parseName(raw: string): NameParts {
  const cleaned = raw.toLowerCase().replace(/[\/_,()]/g, ' ').replace(/-/g, ' ');

  const versions: string[] = [];
  const tokens = new Set<string>();

  for (const tok of cleaned.split(/\s+/)) {
    if (!tok) continue;
    // A version is a bare number, optionally dotted: 4, 4.5, 3.1
    if (/^\d+(?:\.\d+)*$/.test(tok)) {
      versions.push(normaliseVersion(tok));
      continue;
    }
    // Embedded versions: "v3.2", "m2.5", "gpt5", "qwen3.6"
    const embedded = /^([a-z]+)(\d+(?:\.\d+)*)$/.exec(tok);
    if (embedded) {
      if (!NOISE_TOKENS.has(embedded[1])) tokens.add(embedded[1]);
      versions.push(normaliseVersion(embedded[2]));
      continue;
    }
    if (!NOISE_TOKENS.has(tok)) tokens.add(tok);
  }

  return { tokens, versions: versions.sort() };
}

/** "4.50" and "4.5" are the same version; "4" and "4.0" are the same too. */
function normaliseVersion(v: string): string {
  const parts = v.split('.').map((p) => String(Number(p)));
  while (parts.length > 1 && parts[parts.length - 1] === '0') parts.pop();
  return parts.join('.');
}

export interface MatchCandidate {
  /** OpenRouter slug, e.g. anthropic/claude-opus-4.6 */
  id: string;
  /** Human name from the catalog, if available. */
  name?: string;
}

export interface MatchResult {
  id: string;
  confidence: number;
}

/**
 * Match a Terminal-Bench display name against the OpenRouter catalog.
 *
 * Returns null rather than a weak guess. An unmatched harness score is a small
 * loss; a wrongly matched one silently attributes measured performance to the
 * wrong model, which is exactly the failure this whole schema exists to avoid.
 */
export function matchModel(
  displayName: string,
  candidates: MatchCandidate[],
  minConfidence = 0.6,
): MatchResult | null {
  const want = parseName(displayName);
  if (want.tokens.size === 0) return null;

  let best: MatchResult | null = null;

  for (const c of candidates) {
    // Slug and display name together: the slug carries the vendor prefix,
    // the display name often carries words the slug omits.
    const have = parseName(`${c.id} ${c.name ?? ''}`);

    // Version gate. If both sides declare versions, they must intersect.
    if (want.versions.length > 0 && have.versions.length > 0) {
      const shared = want.versions.some((v) => have.versions.includes(v));
      if (!shared) continue;
    }
    // A versioned query must not match an unversioned candidate, or
    // "Claude Opus 4.6" would match a bare "claude-opus".
    if (want.versions.length > 0 && have.versions.length === 0) continue;

    let overlap = 0;
    for (const t of want.tokens) if (have.tokens.has(t)) overlap++;
    if (overlap === 0) continue;

    // Precision against the query's own tokens, lightly penalised for
    // candidates carrying many extra tokens.
    const recall = overlap / want.tokens.size;
    const precision = overlap / Math.max(1, have.tokens.size);
    const confidence = recall * 0.75 + precision * 0.25;

    if (!best || confidence > best.confidence) {
      best = { id: c.id, confidence };
    }
  }

  return best && best.confidence >= minConfidence ? best : null;
}

// ---------------------------------------------------------------------------
// Harness deltas
// ---------------------------------------------------------------------------

/** A stable harness id from a display name: "Claude Code" -> "claude-code". */
export function harnessId(agent: string): string {
  return agent.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Collapse duplicate (agent, model) submissions.
 *
 * The live board contains repeats — the same agent and model submitted twice
 * with different scores. Keeping the highest matches how the leaderboard itself
 * presents a configuration's best verified result.
 */
export function dedupe(entries: TBEntry[]): TBEntry[] {
  const best = new Map<string, TBEntry>();
  for (const e of entries) {
    const key = `${harnessId(e.agent)}::${e.model.toLowerCase()}`;
    const prev = best.get(key);
    if (!prev || e.accuracy > prev.accuracy) best.set(key, e);
  }
  return [...best.values()];
}

export interface HarnessDelta {
  modelId: string;
  harnessId: string;
  accuracy: number;
  /** Percentage points above/below this model's mean across harnesses. */
  delta: number;
  /** 0–100, the H term. 50 is average for this model. */
  harnessScore: number;
}

/**
 * Compute per-harness deltas.
 *
 * The point is not the raw accuracy — that mostly tracks model quality, which
 * `Q` already covers. The point is the SPREAD: on the live board, Claude Opus
 * 4.5 ranges from ~63% under Droid to ~52% under Claude Code, an eleven-point
 * swing on an identical model. That swing is what `H` is meant to capture, and
 * it is why ranking models without their harness gives wrong answers for CLI
 * work.
 *
 * A model measured in only one harness has no spread to speak of, so it scores
 * a neutral 50 rather than an unearned 100.
 */
export function computeDeltas(
  matched: Array<{ modelId: string; harnessId: string; accuracy: number }>,
): HarnessDelta[] {
  const byModel = new Map<string, typeof matched>();
  for (const m of matched) {
    const list = byModel.get(m.modelId) ?? [];
    list.push(m);
    byModel.set(m.modelId, list);
  }

  const out: HarnessDelta[] = [];
  for (const [modelId, rows] of byModel) {
    const mean = rows.reduce((a, r) => a + r.accuracy, 0) / rows.length;

    // Spread across harnesses for this model, used to scale the delta.
    const max = Math.max(...rows.map((r) => r.accuracy));
    const min = Math.min(...rows.map((r) => r.accuracy));
    const spread = max - min;

    for (const r of rows) {
      const delta = (r.accuracy - mean) * 100;
      const harnessScore =
        rows.length < 2 || spread === 0
          ? 50
          : Math.max(0, Math.min(100, 50 + ((r.accuracy - mean) / spread) * 100));
      out.push({
        modelId,
        harnessId: r.harnessId,
        accuracy: r.accuracy,
        delta: Math.round(delta * 10) / 10,
        harnessScore: Math.round(harnessScore * 10) / 10,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

export interface IngestReport {
  version: string;
  fetched: number;
  attributable: number;
  matched: number;
  unmatched: string[];
  harnessRows: number;
}

/**
 * Fetch and ingest one leaderboard version.
 *
 * Fails LOUDLY: if the page returns nothing parseable, the function throws
 * rather than writing zero rows. Existing harness scores are left untouched and
 * the sync run is marked partial, so the board keeps serving the last good
 * harness data and the failure is visible on /health.
 */
export async function ingestLeaderboard(
  db: D1Database,
  versionIndex: number,
  fetchImpl: typeof fetch = fetch,
): Promise<IngestReport> {
  const board = LEADERBOARDS[versionIndex];
  if (!board) throw new Error(`unknown leaderboard index ${versionIndex}`);

  const res = await fetchImpl(board.url, {
    headers: { 'user-agent': 'ModelMap/1.0 (+personal research tool)' },
  });
  if (!res.ok) throw new Error(`terminal-bench ${board.version}: HTTP ${res.status}`);

  const html = await res.text();
  const parsed = parseLeaderboard(html);

  // Loud failure: the board has ~140 entries. A collapse to near-zero means the
  // markup changed, not that every agent was delisted.
  if (parsed.length < 10) {
    throw new Error(
      `terminal-bench ${board.version}: parsed only ${parsed.length} rows — markup likely changed`,
    );
  }

  const attributable = dedupe(parsed.filter(isAttributable));

  const { results: catalog } = await db
    .prepare(`SELECT DISTINCT model_id AS id FROM offerings`)
    .all<{ id: string }>();

  const matched: Array<{ modelId: string; harnessId: string; accuracy: number }> = [];
  const unmatched: string[] = [];

  for (const e of attributable) {
    const m = matchModel(e.model, catalog ?? []);
    if (m) {
      matched.push({ modelId: m.id, harnessId: harnessId(e.agent), accuracy: e.accuracy });
    } else if (!unmatched.includes(e.model)) {
      unmatched.push(e.model);
    }
  }

  const deltas = computeDeltas(matched);
  const asOf = new Date().toISOString();

  const stmt = db.prepare(
    `INSERT INTO scores (model_id, harness_id, benchmark, value, normalised, score_scope, source, as_of, score_key)
     VALUES (?1, ?2, ?3, ?4, ?5, 'harness_measured', 'terminal-bench', ?6, ?7)
     ON CONFLICT(model_id, harness_id, benchmark) DO UPDATE SET
       value      = excluded.value,
       normalised = excluded.normalised,
       as_of      = excluded.as_of,
       score_key  = excluded.score_key`,
  );

  if (deltas.length > 0) {
    await db.batch(
      deltas.map((d) =>
        stmt.bind(d.modelId, d.harnessId, board.benchmark, d.accuracy, d.harnessScore, asOf,
          baseSlug(d.modelId)),
      ),
    );
  }

  return {
    version: board.version,
    fetched: parsed.length,
    attributable: attributable.length,
    matched: matched.length,
    unmatched,
    harnessRows: deltas.length,
  };
}

export const LEADERBOARD_COUNT = LEADERBOARDS.length;
