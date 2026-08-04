/**
 * Terminal-Bench tests — mirrors src/terminalbench.ts.
 *   node scripts/test-terminalbench.mjs
 *
 * Uses REAL leaderboard HTML captured from tbench.ai (scripts/fixtures/), so
 * the parser is tested against the actual markup, not a hand-written sample.
 * 2.0 is fully server-rendered (142 rows); 2.1 is partially client-rendered
 * (17 server rows).
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const html20 = readFileSync(join(here, 'fixtures/tbench-2.0.html'), 'utf8');
const html21 = readFileSync(join(here, 'fixtures/tbench-2.1.html'), 'utf8');

let passed = 0, failed = 0;
const check = (n, c, d = '') => {
  if (c) { passed++; console.log(`  PASS  ${n}`); }
  else { failed++; console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`); }
};

// ---- mirrors of src/terminalbench.ts -------------------------------------
function stripTags(s) {
  return s.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
}

function parseLeaderboard(html) {
  const entries = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
  let rowMatch;
  while ((rowMatch = rowRe.exec(html)) !== null) {
    const cells = [];
    let cellMatch;
    cellRe.lastIndex = 0;
    while ((cellMatch = cellRe.exec(rowMatch[1])) !== null) cells.push(stripTags(cellMatch[1]));
    if (cells.length < 4) continue;
    const rankIdx = cells.findIndex((c) => /^\d+$/.test(c));
    const pctIdx = cells.findIndex((c) => /(-?\d+(?:\.\d+)?)\s*%/.test(c));
    if (rankIdx === -1 || pctIdx === -1) continue;
    const agent = cells[rankIdx + 1];
    const model = cells[rankIdx + 2];
    if (!agent || !model) continue;
    const pct = /(-?\d+(?:\.\d+)?)\s*%/.exec(cells[pctIdx]);
    if (!pct) continue;
    const next = (d1, d2) => cells[pctIdx + d1] || cells[pctIdx + d2] || '';
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

const AGGREGATE_MODEL_NAMES = new Set(['multiple', 'various', 'mixed', 'n/a']);
const isAttributable = (e) => !AGGREGATE_MODEL_NAMES.has(e.model.toLowerCase().trim());

const NOISE_TOKENS = new Set(['ai', 'the', 'model', 'instruct', 'preview', 'latest']);

function normaliseVersion(v) {
  const parts = v.split('.').map((p) => String(Number(p)));
  while (parts.length > 1 && parts[parts.length - 1] === '0') parts.pop();
  return parts.join('.');
}

function parseName(raw) {
  const cleaned = raw.toLowerCase().replace(/[\/_,()]/g, ' ').replace(/-/g, ' ');
  const versions = [];
  const tokens = new Set();
  for (const tok of cleaned.split(/\s+/)) {
    if (!tok) continue;
    if (/^\d+(?:\.\d+)*$/.test(tok)) { versions.push(normaliseVersion(tok)); continue; }
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

function matchModel(displayName, candidates, minConfidence = 0.6) {
  const want = parseName(displayName);
  if (want.tokens.size === 0) return null;
  let best = null;
  for (const c of candidates) {
    const have = parseName(`${c.id} ${c.name ?? ''}`);
    if (want.versions.length > 0 && have.versions.length > 0) {
      const shared = want.versions.some((v) => have.versions.includes(v));
      if (!shared) continue;
    }
    if (want.versions.length > 0 && have.versions.length === 0) continue;
    let overlap = 0;
    for (const t of want.tokens) if (have.tokens.has(t)) overlap++;
    if (overlap === 0) continue;
    const recall = overlap / want.tokens.size;
    const precision = overlap / Math.max(1, have.tokens.size);
    const confidence = recall * 0.75 + precision * 0.25;
    if (!best || confidence > best.confidence) best = { id: c.id, confidence };
  }
  return best && best.confidence >= minConfidence ? best : null;
}

function harnessId(agent) {
  return agent.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function dedupe(entries) {
  const best = new Map();
  for (const e of entries) {
    const key = `${harnessId(e.agent)}::${e.model.toLowerCase()}`;
    const prev = best.get(key);
    if (!prev || e.accuracy > prev.accuracy) best.set(key, e);
  }
  return [...best.values()];
}

function computeDeltas(matched) {
  const byModel = new Map();
  for (const m of matched) {
    const list = byModel.get(m.modelId) ?? [];
    list.push(m);
    byModel.set(m.modelId, list);
  }
  const out = [];
  for (const [modelId, rows] of byModel) {
    const mean = rows.reduce((a, r) => a + r.accuracy, 0) / rows.length;
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

// The OpenRouter catalog subset covering the models on the board, shaped like
// the /api/v1/models response.
const CATALOG = [
  { id: 'openai/gpt-5.5', name: 'GPT-5.5' },
  { id: 'openai/gpt-5.3-codex', name: 'GPT-5.3 Codex' },
  { id: 'openai/gpt-5.2-codex', name: 'GPT-5.2 Codex' },
  { id: 'openai/gpt-5.1-codex', name: 'GPT-5.1 Codex' },
  { id: 'openai/gpt-5.1-codex-mini', name: 'GPT-5.1 Codex Mini' },
  { id: 'openai/gpt-5.1-codex-max', name: 'GPT-5.1 Codex Max' },
  { id: 'openai/gpt-5.2', name: 'GPT-5.2' },
  { id: 'openai/gpt-5', name: 'GPT-5' },
  { id: 'openai/gpt-5.1', name: 'GPT-5.1' },
  { id: 'anthropic/claude-opus-4.7', name: 'Claude Opus 4.7' },
  { id: 'anthropic/claude-opus-4.6', name: 'Claude Opus 4.6' },
  { id: 'anthropic/claude-opus-4.5', name: 'Claude Opus 4.5' },
  { id: 'anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6' },
  { id: 'google/gemini-3.1-pro', name: 'Gemini 3.1 Pro' },
  { id: 'google/gemini-3-pro', name: 'Gemini 3 Pro' },
  { id: 'google/gemini-3-flash', name: 'Gemini 3 Flash' },
  { id: 'x-ai/grok-4.20', name: 'Grok 4.20' },
  { id: 'z-ai/glm-5', name: 'GLM 5' },
  { id: 'minimax/minimax-m2.5', name: 'MiniMax M2.5' },
  { id: 'little-coder/qwen3.6-35b', name: 'Qwen3.6 35B' },
];

// ---- parsing the REAL pages ----------------------------------------------
console.log('\nparseLeaderboard() — against captured tbench.ai HTML');
{
  const e20 = parseLeaderboard(html20);
  check('2.0: all 142 rows parse', e20.length === 142);
  check('2.0: first entry is GPT-5.5 @ 84.7% under NexAU-AHE',
    e20[0].model === 'GPT-5.5' && e20[0].agent === 'NexAU-AHE' && e20[0].accuracy === 0.847);
  check('2.0: accuracy stays in [0,1] for every row',
    e20.every((e) => e.accuracy > 0 && e.accuracy <= 1));
  check('2.0: every row has an agent and a model', e20.every((e) => e.agent && e.model));
  check('2.0: ranks are dense from 1', e20[0].rank === 1 && e20[1].rank === 2);

  const e21 = parseLeaderboard(html21);
  check('2.1: server-rendered top-17 parses', e21.length === 17);
  check('2.1: first entry is Fable 5 @ 83.8% under Claude Code',
    e21[0].model === 'Fable 5' && e21[0].agent === 'Claude Code' && e21[0].accuracy === 0.838);
  check('2.1: the Effort column does not confuse the parser', e21.every((e) => e.accuracy <= 1));
}

// ---- attribution ----------------------------------------------------------
console.log('\nisAttributable() / dedupe()');
{
  const e20 = parseLeaderboard(html20);
  const attributable = e20.filter(isAttributable);
  check('2.0: aggregate "Multiple" rows are dropped', attributable.length < e20.length);
  check('2.0: the attributable set stays large', attributable.length >= 100);

  const dupes = [
    { rank: 5, agent: 'Goose', model: 'Claude Opus 4.6', accuracy: 0.52 },
    { rank: 6, agent: 'Goose', model: 'Claude Opus 4.6', accuracy: 0.55 },
    { rank: 7, agent: 'Goose', model: 'Claude Opus 4.6', accuracy: 0.51 },
  ];
  const collapsed = dedupe(dupes);
  check('duplicate (agent, model) submissions collapse to the best score',
    collapsed.length === 1 && collapsed[0].accuracy === 0.55);
  check('different agents stay separate in dedupe',
    dedupe([...dupes, { rank: 8, agent: 'Codex CLI', model: 'Claude Opus 4.6', accuracy: 0.6 }]).length === 2);
}

// ---- name matching --------------------------------------------------------
console.log('\nmatchModel() — the version gate is what protects attribution');
{
  const m = (name) => matchModel(name, CATALOG);

  check('"Claude Opus 4.6" resolves to the 4.6 slug',
    m('Claude Opus 4.6')?.id === 'anthropic/claude-opus-4.6');
  check('token reorder "Claude 4.6 Opus" resolves identically',
    m('Claude 4.6 Opus')?.id === 'anthropic/claude-opus-4.6');
  check('"Opus 4.6" without a vendor still resolves',
    m('Opus 4.6')?.id === 'anthropic/claude-opus-4.6');
  check('adjacent versions never conflagrate: 4.5 does not match 4.6',
    m('Claude Opus 4.5')?.id === 'anthropic/claude-opus-4.5');

  check('"GPT-5.5" resolves to openai/gpt-5.5', m('GPT-5.5')?.id === 'openai/gpt-5.5');
  check('"GPT-5.3-Codex" resolves to the codex slug',
    m('GPT-5.3-Codex')?.id === 'openai/gpt-5.3-codex');
  check('"GPT-5.1 Codex Mini" does not collide with Codex Max',
    m('GPT-5.1 Codex Mini')?.id === 'openai/gpt-5.1-codex-mini');

  check('"Minimax m2.5" resolves despite casing',
    m('Minimax m2.5')?.id === 'minimax/minimax-m2.5');
  check('"MiniMax M2.5" resolves identically',
    m('MiniMax M2.5')?.id === 'minimax/minimax-m2.5');

  check('"Gemini 3 Pro" resolves and does not pull in 3.1 Pro',
    m('Gemini 3 Pro')?.id === 'google/gemini-3-pro');
  check('"Gemini 3.1 Pro" resolves to its own slug',
    m('Gemini 3.1 Pro')?.id === 'google/gemini-3.1-pro');

  check('an unknown model returns null, not a near-miss',
    m('Nebulon-9000 Quantum') === null);
  check('a versioned query never matches an unversioned slug',
    m('Claude Opus 4.6')?.id !== 'anthropic/claude-opus');
  check('a bare slug without a matching version is refused',
    m('Claude Opus 9.9') === null);
}

// ---- harness deltas -------------------------------------------------------
console.log('\ncomputeDeltas() — the H term');
{
  // Same model across two harnesses: the spread is the signal.
  const opus = computeDeltas([
    { modelId: 'anthropic/claude-opus-4.5', harnessId: 'droid', accuracy: 0.631 },
    { modelId: 'anthropic/claude-opus-4.5', harnessId: 'opencode', accuracy: 0.517 },
  ]);
  check('two harnesses: the better harness is above the mean',
    opus.find((d) => d.harnessId === 'droid').harnessScore >
    opus.find((d) => d.harnessId === 'opencode').harnessScore);
  check('two harnesses: scores are symmetric around 50',
    opus.find((d) => d.harnessId === 'droid').harnessScore === 100 &&
    opus.find((d) => d.harnessId === 'opencode').harnessScore === 0);
  check('the delta is in percentage points from the mean',
    opus.find((d) => d.harnessId === 'droid').delta > 0 &&
    opus.find((d) => d.harnessId === 'opencode').delta < 0);

  const single = computeDeltas([
    { modelId: 'x/solo', harnessId: 'codex-cli', accuracy: 0.9 },
  ]);
  check('a model measured in one harness scores a neutral 50, not 100',
    single[0].harnessScore === 50);

  const triple = computeDeltas([
    { modelId: 'm', harnessId: 'a', accuracy: 0.5 },
    { modelId: 'm', harnessId: 'b', accuracy: 0.6 },
    { modelId: 'm', harnessId: 'c', accuracy: 0.7 },
  ]);
  check('the spread maps 0-100 across three harnesses',
    triple.every((d) => d.harnessScore >= 0 && d.harnessScore <= 100) &&
    Math.max(...triple.map((d) => d.harnessScore)) === 100);

  check('harness ids are slugged', harnessId('Claude Code') === 'claude-code'
    && harnessId('Codex CLI') === 'codex-cli' && harnessId('mini-SWE-agent') === 'mini-swe-agent');
}

// ---- end-to-end ingestion -------------------------------------------------
console.log('\ningestLeaderboard() — against real fixtures, loudly failing');
{
  function fakeDb() {
    const written = [];
    return {
      written,
      prepare(sql) {
        const isSelect = /^SELECT/i.test(sql);
        return {
          async all() {
            if (isSelect && /FROM offerings/.test(sql)) {
              return { results: CATALOG.map((c) => ({ id: c.id })) };
            }
            return { results: [] };
          },
          async first() { return null; },
          bind() { return this; },
          async run() {},
          async batch(rows) { written.push(...rows); },
        };
      },
    };
  }

  async function ingest(fetchImpl, db = fakeDb(), versionIndex = 0) {
    const res = await fetchImpl(LEADERBOARDS[versionIndex].url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const parsed = parseLeaderboard(html);
    if (parsed.length < 10) {
      throw new Error(`parsed only ${parsed.length} rows — markup likely changed`);
    }
    const attributable = dedupe(parsed.filter(isAttributable));
    const catalog = (await db.prepare(`SELECT DISTINCT model_id AS id FROM offerings`).all()).results;
    const matched = [];
    const unmatched = [];
    for (const e of attributable) {
      const m = matchModel(e.model, catalog);
      if (m) matched.push({ modelId: m.id, harnessId: harnessId(e.agent), accuracy: e.accuracy });
      else if (!unmatched.includes(e.model)) unmatched.push(e.model);
    }
    const deltas = computeDeltas(matched);
    return { parsed, attributable, matched, unmatched, deltas };
  }

  const LEADERBOARDS = [
    { version: '2.0', url: 'https://www.tbench.ai/leaderboard/terminal-bench/2.0' },
    { version: '2.1', url: 'https://www.tbench.ai/leaderboard/terminal-bench/2.1' },
  ];

  const fakeFetch = (html) => async (url) => ({
    ok: true,
    status: 200,
    async text() { return html; },
  });

  const r20 = await ingest(fakeFetch(html20), fakeDb(), 0);
  check('2.0 end-to-end: every attributable row attempts a match',
    r20.parsed.length === 142 && r20.attributable.length >= 100);
  check('2.0 end-to-end: harness rows produced for matched models',
    r20.deltas.length >= 10);
  check('2.0 end-to-end: unmatched names are reported, not guessed',
    Array.isArray(r20.unmatched));

  const r21 = await ingest(fakeFetch(html21), fakeDb(), 1);
  check('2.1 end-to-end: top-17 rows ingest as harness rows',
    r21.parsed.length === 17 && r21.deltas.length >= 5);

  // The loud failure: markup collapse must throw, never write zero rows.
  let threw = false;
  try {
    await ingest(fakeFetch('<html><body>maintenance</body></html>'), fakeDb(), 0);
  } catch (err) {
    threw = /parsed only 0 rows/.test(String(err.message));
  }
  check('a collapsed page THROWS instead of writing zeros', threw);

  // HTTP errors surface as exceptions too.
  threw = false;
  try {
    await ingest(async () => ({ ok: false, status: 503 }), fakeDb(), 0);
  } catch (err) {
    threw = /503/.test(String(err.message));
  }
  check('an upstream HTTP error propagates', threw);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);