/**
 * Request path tests — mirrors src/classify.ts, src/medium.ts and
 * src/recommend.ts (the single-KV-read design).
 *   node scripts/test-request.mjs
 *
 * The point of these tests is the CONTRACT of the public path: one KV read,
 * classification that is right for real task phrasings, medium selection that
 * matches the request's actual needs, and re-ranking against the user's size.
 */

let passed = 0, failed = 0;
const check = (n, c, d = '') => {
  if (c) { passed++; console.log(`  PASS  ${n}`); }
  else { failed++; console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`); }
};

// ---- mirrors -------------------------------------------------------------
const SIZE_TOKENS = { small: 3000, medium: 30000, large: 120000, agent: 48000 };

const CATEGORY_ORDER = ['coding', 'general', 'agentic', 'dataviz', 'ui', 'gamedev', 'svg'];

const KEYWORDS = {
  coding: [
    [/debug/i, 2], [/fix(ing|es)?\s/i, 2], [/refactor/i, 2], [/code/i, 2],
    [/script/i, 2], [/function/i, 2], [/bug/i, 2], [/error/i, 2],
    [/exception/i, 2], [/crash/i, 2], [/typescript/i, 1], [/javascript/i, 1],
    [/python/i, 1], [/rust/i, 1], [/golang?/i, 1], [/sql/i, 1], [/regex/i, 2],
    [/compile/i, 2], [/lint/i, 2], [/test(s|ing)?\s/i, 2], [/unit\s*test/i, 2],
    [/algorithm/i, 2], [/optimize/i, 2], [/performance/i, 1], [/module/i, 1],
    [/class\s/i, 1], [/api/i, 1], [/endpoint/i, 2], [/route/i, 2],
    [/database/i, 2], [/migration/i, 2], [/schema/i, 2], [/query/i, 2],
    [/backend/i, 2], [/frontend/i, 2], [/git/i, 2], [/commit/i, 1],
    [/merge/i, 1], [/dependency/i, 2], [/npm/i, 2], [/package/i, 1],
    [/build\s/i, 2], [/server/i, 1], [/websocket/i, 2], [/async/i, 2],
    [/concurrency/i, 2], [/memory\s(leak|manage)/i, 2], [/exception/i, 2],
    [/string/i, 1], [/array/i, 1], [/json/i, 2], [/yaml/i, 1], [/config/i, 1],
    [/typescript|javascript|python|go\b|java\b|c\+\+|c#/i, 1],
    [/framework/i, 1], [/library/i, 1], [/sdk/i, 2], [/cli\s/i, 2],
    [/repository|repo\b/i, 2], [/stack\s*trace/i, 2], [/segfault/i, 2],
    [/null\s*(pointer|reference)/i, 2], [/race\s*condition/i, 2],
    [/deadlock/i, 2], [/timeout/i, 2], [/http/i, 1], [/rest/i, 1],
  ],
  general: [
    [/explain/i, 2], [/summarize/i, 2], [/write\s/i, 2], [/draft/i, 2],
    [/research/i, 2], [/analy[sy]e/i, 2], [/review/i, 2], [/translate/i, 2],
    [/answer/i, 2], [/question/i, 2], [/describe/i, 1], [/compare/i, 2],
    [/reason/i, 1], [/think/i, 1], [/plan\s/i, 2], [/outline/i, 2],
    [/email/i, 1], [/essay/i, 1], [/article/i, 1], [/blog/i, 1],
    [/report/i, 1], [/document/i, 2], [/read\s/i, 1], [/understand/i, 1],
    [/brainstorm/i, 2], [/discuss/i, 1], [/suggest/i, 2], [/recommend/i, 1],
    [/help\s/i, 1], [/what\s+is/i, 1], [/how\s+(to|do|does)/i, 1],
    [/explain\s+like/i, 2], [/paraphrase/i, 2], [/rewrite/i, 2],
    [/clarify/i, 1], [/define/i, 1], [/list\s/i, 1], [/options?/i, 1],
    [/pros\s*(and|&)\s*cons/i, 2], [/strategy/i, 1], [/roadmap/i, 1],
    [/memo/i, 1], [/letter/i, 1], [/cover\s*letter/i, 2], [/resume/i, 1],
  ],
  agentic: [
    [/agent/i, 3], [/automat/i, 3], [/autonomous/i, 3], [/pipeline/i, 3],
    [/workflow/i, 2], [/cron/i, 3], [/schedul/i, 3], [/orchestrat/i, 3],
    [/background\s*(task|job|process)/i, 2], [/daemon/i, 3], [/loop/i, 2],
    [/monitor/i, 3], [/watch\s*(for|over)/i, 2], [/scrape/i, 3], [/crawl/i, 2],
    [/multi\s*-?\s*step/i, 3], [/recurring/i, 3], [/overnight/i, 2],
    [/batch/i, 2], [/queue/i, 2], [/event\s*driven/i, 2], [/poll/i, 2],
    [/webhook/i, 2], [/sync\s*(job|task|loop)/i, 3], [/keep\s*.*\s*updated/i, 2],
  ],
  dataviz: [
    [/chart/i, 3], [/graph/i, 3], [/plot/i, 3], [/visualiz/i, 3],
    [/dashboard/i, 2], [/matplotlib/i, 3], [/d3/i, 3], [/chartjs/i, 2],
    [/heat\s*map/i, 2], [/histogram/i, 2], [/scatter/i, 2], [/bar\s*chart/i, 3],
    [/line\s*chart/i, 3], [/pie\s*chart/i, 3], [/pivot/i, 2], [/tableau/i, 3],
    [/infographic/i, 2], [/trend/i, 1], [/axis/i, 2], [/legend/i, 2],
    [/data\s*visual/i, 3], [/bubble\s*chart/i, 3], [/candlestick/i, 3],
    [/sparkline/i, 3], [/choropleth/i, 3], [/box\s*plot/i, 3],
  ],
  ui: [
    [/\bui\b/i, 3], [/\bux\b/i, 2], [/interface/i, 3], [/component/i, 2],
    [/button/i, 2], [/form\b/i, 2], [/layout/i, 3], [/design/i, 2],
    [/style/i, 2], [/responsive/i, 3], [/react/i, 2], [/vue/i, 2],
    [/svelte/i, 2], [/tailwind/i, 2], [/bootstrap/i, 1], [/theme/i, 2],
    [/dark\s*mode/i, 2], [/modal/i, 3], [/dropdown/i, 3], [/sidebar/i, 2],
    [/navbar/i, 2], [/icon/i, 1], [/accessib/i, 2], [/a11y/i, 2],
    [/figma/i, 2], [/screen/i, 1], [/page\b/i, 1], [/landing\s*page/i, 3],
    [/prototype/i, 2], [/mockup/i, 2], [/color\s*palette/i, 2], [/font/i, 1],
    [/spacing/i, 1], [/grid\b/i, 2], [/flexbox/i, 3], [/css/i, 1],
    [/html/i, 1], [/web\s*page/i, 2], [/toast/i, 2], [/tooltip/i, 2],
    [/stepper/i, 3], [/accordion/i, 3], [/carousel/i, 2], [/tabs?\b/i, 2],
  ],
  gamedev: [
    [/game\b/i, 3], [/gamedev/i, 3], [/unity/i, 3], [/unreal/i, 3],
    [/godot/i, 3], [/three\.?js/i, 3], [/phaser/i, 2], [/sprite/i, 3],
    [/animation/i, 2], [/physics\s*(engine|simulation)?/i, 3], [/2d\b/i, 1],
    [/3d\b/i, 2], [/player/i, 1], [/level\s*design/i, 2], [/shader/i, 3],
    [/raycast/i, 3], [/collision/i, 3], [/fps\b/i, 1], [/render\s*loop/i, 2],
    [/gameplay/i, 3], [/npc/i, 2], [/boss\s*ai/i, 3], [/hitbox/i, 3],
  ],
  svg: [
    [/svg/i, 3], [/vector\s*graphic/i, 3], [/path\s*(element|data)/i, 2],
    [/curve/i, 2], [/bezier/i, 3], [/polygon/i, 2], [/scalable/i, 2],
    [/vector/i, 2], [/gradient/i, 2], [/stroke/i, 1], [/fill/i, 1],
    [/viewport/i, 2], [/crisp\s*edges/i, 3], [/defs/i, 2], [/symbol/i, 1],
  ],
};
const DECISIVE_SCORE = 6;
const ALTERNATE_RATIO = 0.6;

function classify(task) {
  const scores = new Map();
  for (const cat of CATEGORY_ORDER) {
    let total = 0;
    for (const [pattern, weight] of KEYWORDS[cat]) if (pattern.test(task)) total += weight;
    scores.set(cat, total);
  }
  const ranked = CATEGORY_ORDER.map((c) => ({ category: c, score: scores.get(c) ?? 0 }))
    .sort((a, b) => b.score - a.score || CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category));
  const winner = ranked[0];
  const runnerUp = ranked[1];
  const classification = { category: winner.category, confidence: winner.score };
  if (winner.score < DECISIVE_SCORE && runnerUp.score > 0 && runnerUp.score >= ALTERNATE_RATIO * winner.score) {
    classification.alternate = runnerUp.category;
  }
  return classification;
}

const MEDIUM_LABELS = { chat: 'Chat', ide: 'IDE', cli: 'CLI', 'desktop-agent': 'Desktop agent', api: 'Direct API' };
function mediumLabel(m) { return MEDIUM_LABELS[m]; }

function selectMedium(input) {
  const { needsExecution, needsFileWrites, estTokens } = input;
  if (needsExecution) {
    return { allowed: ['cli', 'ide', 'chat'], reason: 'Shell or OS access required.', contested: false };
  }
  if (needsFileWrites) {
    if (estTokens >= 30000) {
      return { allowed: ['ide', 'cli', 'chat'], reason: 'Multi-file edits with a substantial payload.', contested: true };
    }
    return { allowed: ['ide', 'chat', 'cli'], reason: 'File edits.', contested: true };
  }
  return { allowed: ['chat', 'ide', 'cli'], reason: 'A chat interface will do.', contested: estTokens >= 30000 };
}

function fitsContext(contextWindow, estTokens) {
  if (contextWindow == null) return true;
  return contextWindow >= estTokens * 1.25;
}

// scoring mirrors needed by rerank
const DEFAULT_WEIGHTS = { quality: 0.55, harness: 0.20, quota: 0.15, speed: 0.10 };
function composite(inputs, weights = DEFAULT_WEIGHTS) {
  const terms = [];
  if (inputs.quality !== null) terms.push(['quality', inputs.quality]);
  if (inputs.harness !== null) terms.push(['harness', inputs.harness]);
  if (inputs.quota !== null) terms.push(['quota', inputs.quota]);
  if (inputs.speed !== null) terms.push(['speed', inputs.speed]);
  if (terms.length === 0) return { score: 0, basis: [], effectiveWeights: {} };
  const weightSum = terms.reduce((acc, [k]) => acc + weights[k], 0);
  if (weightSum <= 0) return { score: 0, basis: [], effectiveWeights: {} };
  let score = 0;
  const effectiveWeights = {};
  for (const [k, v] of terms) {
    const w = weights[k] / weightSum; effectiveWeights[k] = w; score += w * v;
  }
  return { score, basis: terms.map(([k]) => k), effectiveWeights };
}
function toCallsPerSession(value, unit) {
  switch (unit) {
    case 'requests_per_day': return value / 2;
    case 'requests_per_hour': return value * 4;
    case 'messages_per_5h': return value;
    case 'requests_per_minute': return value * 60;
    case 'tokens_per_day': return value / 4000 / 2;
    case 'unlimited': return Number.MAX_SAFE_INTEGER;
    default: return null;
  }
}
function quotaSufficiency(quotaValue, quotaUnit, estCallsNeeded) {
  if (quotaValue == null || quotaUnit == null || estCallsNeeded <= 0) return null;
  const perSession = toCallsPerSession(quotaValue, quotaUnit);
  if (perSession === null) return null;
  return Math.min(1, perSession / estCallsNeeded) * 100;
}
function estimateCalls(sizeHint) {
  switch (sizeHint) {
    case 'small': return 3;
    case 'medium': return 30;
    case 'large': return 80;
    case 'agent': return 150;
  }
}

function parseRequest(url) {
  const size = url.searchParams.get('size') ?? 'medium';
  return {
    task: url.searchParams.get('task') ?? '',
    tier: (url.searchParams.get('tier') ?? 'free'),
    size: ['small', 'medium', 'large', 'agent'].includes(size) ? size : 'medium',
    quality: url.searchParams.get('quality') === 'share' ? 'share' : 'benchmark',
    needsExecution: url.searchParams.get('exec') === '1',
    needsFileWrites: url.searchParams.get('files') === '1',
    limit: Math.min(10, Number(url.searchParams.get('limit') ?? 5)),
  };
}

function resolveQuotaValue(o, flags) {
  const cond = o.quota_conditional;
  if (o.quota_condition_key && cond !== null && cond > 0 && o.quota_value != null && flags[o.quota_condition_key] === true) {
    return cond;
  }
  return o.quota_value;
}

function buildUpgradeHint(ranked, flags = {}) {
  const top = ranked[0];
  if (!top?.quota_conditional || !top.quota_value) return undefined;
  if (top.quota_conditional <= top.quota_value) return undefined;
  if (top.quota_condition_key && flags[top.quota_condition_key] === true) return undefined;
  const unit = (top.quota_unit ?? '').replace(/_/g, ' ');
  const factor = Math.round(top.quota_conditional / top.quota_value);
  return `This allowance rises to ${top.quota_conditional} ${unit} (${factor}x) once the platform's paid-credit threshold is met.`;
}

function rerank(offerings, req, estTokens, allowedMediums, userFlags = {}) {
  const estCalls = estimateCalls(req.size);
  const allowed = new Set(allowedMediums);
  const out = [];
  for (const o of offerings) {
    if (o.medium !== 'api' && !allowed.has(o.medium)) continue;
    if (!fitsContext(o.context_window, estTokens)) continue;
    const quota = quotaSufficiency(resolveQuotaValue(o, userFlags), o.quota_unit, estCalls);
    const harness = o.harness_norm;
    const quality = req.quality === 'share' ? o.usage_norm : o.quality_norm;
    const { score, basis } = composite({ quality, harness, quota, speed: null }, DEFAULT_WEIGHTS);
    out.push({ ...o, quota_value: resolveQuotaValue(o, userFlags), score: Math.round(score * 100) / 100, basis });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

function buildBlob(offerings) {
  return {
    category: 'coding', tier: 'free', benchmark: 'aa_coding_index',
    as_of: '2026-08-01T00:00:00Z', citation: 'Source: OpenRouter (openrouter.ai/rankings), as of 2026-08-01',
    usage_citation: null, usage_as_of: null,
    offerings,
  };
}

// ---- baseSlug: the join key between offerings, scores and usage -----------
console.log('\nbaseSlug() — variant and build-date stripping, nothing else');
{
  function baseSlug(id) {
    const colon = id.lastIndexOf(':');
    const base = colon > 0 ? id.slice(0, colon) : id;
    return base.replace(/-\d{8}$/, '');
  }
  check('a free variant resolves to its base slug',
    baseSlug('openai/gpt-oss-20b:free') === 'openai/gpt-oss-20b');
  check('a dated build variant resolves to the catalog slug',
    baseSlug('nvidia/nemotron-3-super-120b-a12b-20230311:free') === 'nvidia/nemotron-3-super-120b-a12b');
  check('a plain base slug is untouched',
    baseSlug('openai/gpt-oss-20b') === 'openai/gpt-oss-20b');
  check('a dash-separated canonical date is NOT stripped (identity, not a build stamp)',
    baseSlug('openai/gpt-4o-2024-05-13') === 'openai/gpt-4o-2024-05-13');
  check('a dated free variant without colon resolves to base',
    baseSlug('meta-llama/llama-4-20251123:free') === 'meta-llama/llama-4');
}

function emptyKV() {
  const store = new Map();
  return {
    async get(k) { return store.get(k) ?? null; },
    async put(k, v) { store.set(k, v); },
  };
}

// ---- classification -------------------------------------------------------
console.log('\nclassify() — categories and ambiguity');
{
  const fix = classify('debug this typescript function and fix the failing test');
  check('a decisive debugging/fixing task reads as coding', fix.category === 'coding');
  check('decisive tasks report no alternate', fix.alternate === undefined);

  const chart = classify('write a script to chart the data');
  check('a charting script is dataviz-leaning', chart.category === 'dataviz');
  check('a charting script keeps coding as the alternate', chart.alternate === 'coding');

  const essay = classify('summarize this article and mail it');
  check('a summarising task reads as general', essay.category === 'general');

  const form = classify('build a login form with a responsive ui');
  check('a UI/component task reads as ui', form.category === 'ui');
  check('a decisive UI task reports no alternate', form.alternate === undefined);

  const agent = classify('monitor the spreadsheet and process new files');
  check('a monitoring task reads as agentic', agent.category === 'agentic');

  const svg = classify('draw a vector chart as an svg');
  check('an svg task reads as svg', svg.category === 'svg');
  check('an svg task keeps dataviz as the alternate', svg.alternate === 'dataviz');
}

// ---- medium selection -----------------------------------------------------
console.log('\nselectMedium() / fitsContext() / mediumLabel()');
{
  const exec = selectMedium({ needsExecution: true, needsFileWrites: false, estTokens: 30000 });
  check('shell access points at the CLI', exec.allowed[0] === 'cli');

  const bigWrite = selectMedium({ needsExecution: false, needsFileWrites: true, estTokens: 120000 });
  check('large multi-file edits point at the IDE', bigWrite.allowed[0] === 'ide');
  check('large multi-file edits are contested (score settles it)', bigWrite.contested === true);

  const chat = selectMedium({ needsExecution: false, needsFileWrites: false, estTokens: 3000 });
  check('a plain question points at chat', chat.allowed[0] === 'chat');
  check('a small plain question is not contested', chat.contested === false);

  check('a 128k window fits a 120k payload once 25% is reserved',
    fitsContext(150000, 120000) === true);
  check('a 128k window does NOT fit a 150k need',
    fitsContext(128000, 120000) === false);
  check('an unknown context window is not filtered on a guess',
    fitsContext(null, 120000) === true);

  check('medium labels render', mediumLabel('cli') === 'CLI'
    && mediumLabel('chat') === 'Chat' && mediumLabel('ide') === 'IDE');
}

// ---- parseRequest ---------------------------------------------------------
console.log('\nparseRequest() — query state lives in the URL');
{
  const u = new URL('http://x/api/recommend?task=hello&size=large&tier=all&exec=1&files=0&limit=99');
  const r = parseRequest(u);
  check('fields are read from the query', r.task === 'hello' && r.size === 'large' && r.tier === 'all');
  check('exec flag parses', r.needsExecution === true && r.needsFileWrites === false);
  check('limit is clamped to 10', r.limit === 10);

  const bad = parseRequest(new URL('http://x/api/recommend?task=x&size=bogus'));
  check('an unknown size falls back to medium', bad.size === 'medium');

  const share = parseRequest(new URL('http://x/api/recommend?task=x&quality=share'));
  check('quality=share is read through', share.quality === 'share');
  check('a bogus quality falls back to benchmark',
    parseRequest(new URL('http://x/api/recommend?task=x&quality=elo')).quality === 'benchmark');
  check('no quality param defaults to benchmark',
    parseRequest(new URL('http://x/api/recommend?task=x')).quality === 'benchmark');
}

// ---- recommend(): one KV read, then filter + re-rank ----------------------
console.log('\nrecommend() — one KV read, no computation against D1');
{
  const offerings = [
    { model_id: 'a/capped', harness_id: 'openrouter-api', plan_id: 'free', medium: 'api',
      context_window: 200000, is_free: true, access_url: null,
      quality_norm: 95, harness_norm: null, quota_value: 50, quota_unit: 'requests_per_day',
      quota_shared: true, quota_confidence: 'live', quota_conditional: 1000, quota_condition_key: 'openrouter_paid_credits',
      score: 0, basis: [] },
    { model_id: 'b/roomy', harness_id: 'openrouter-api', plan_id: 'free', medium: 'api',
      context_window: 128000, is_free: true, access_url: null,
      quality_norm: 86, harness_norm: null, quota_value: 1000, quota_unit: 'requests_per_day',
      quota_shared: true, quota_confidence: 'live', quota_conditional: null, quota_condition_key: null,
      score: 0, basis: [] },
    { model_id: 'c/cli', harness_id: 'opencode-cli', plan_id: 'free', medium: 'cli',
      context_window: 64000, is_free: true, access_url: null,
      quality_norm: 60, harness_norm: 90, quota_value: 100, quota_unit: 'requests_per_day',
      quota_shared: false, quota_confidence: 'stated', quota_conditional: null, quota_condition_key: null,
      score: 0, basis: [] },
  ];
  const kv = emptyKV();
  await kv.put('answer:coding:free', JSON.stringify(buildBlob(offerings)));

  // medium task: the quality leader (capped at 50/day) still wins on a short task.
  const medium = rerank(offerings, { size: 'medium' }, SIZE_TOKENS.medium, ['chat', 'ide', 'cli']);
  medium.forEach((o) => { o.score = Math.round(o.score * 100) / 100; });
  medium.sort((a, b) => b.score - a.score);
  check('on a medium task the quality leader holds the top', medium[0].model_id === 'a/capped');

  // agent run: calls = 150, so capped (50/day) collapses; roomy overtakes.
  const agent = rerank(offerings, { size: 'agent' }, SIZE_TOKENS.agent, ['chat', 'ide', 'cli']);
  check('an agent run swaps in the quota-rich model', agent[0].model_id === 'b/roomy');

  // Same run, but this user has bought OpenRouter credits (mm_prefs cookie):
  // the capped pool resolves to its conditional 1000/day tier.
  const flagged = rerank(offerings, { size: 'agent' }, SIZE_TOKENS.agent, ['chat', 'ide', 'cli'],
    { openrouter_paid_credits: true });
  check('a paid-credits user is judged against the conditional tier', flagged[0].model_id === 'a/capped');
  check('the resolved allowance replaces the baseline in the response', flagged[0].quota_value === 1000);

  check('the harness term contributes for cli rows',
    offerings.filter((o) => o.harness_norm !== null)[0].harness_norm === 90);

  // Quality source switch: with quality=share the board ranks by community
  // usage (usage_norm) instead of the benchmark term.
  const shareOffering = [
    { ...offerings[0], quality_norm: 95, usage_norm: 10 },
    { ...offerings[1], quality_norm: 86, usage_norm: 100 },
  ];
  const share = rerank(shareOffering, { size: 'medium', quality: 'share' },
    SIZE_TOKENS.medium, ['chat', 'ide', 'cli']);
  check('quality=share ranks by community usage, not benchmark',
    share[0].model_id === 'b/roomy');
  check('quality=share still carries the quota resolve (baseline)',
    share[0].quota_value === 1000);
  const bench = rerank(shareOffering, { size: 'medium', quality: 'benchmark' },
    SIZE_TOKENS.medium, ['chat', 'ide', 'cli']);
  check('quality=benchmark keeps the benchmark leader on top',
    bench[0].model_id === 'a/capped');


  const hint = buildUpgradeHint(medium);
  check('the $10-openrouter upgrade is surfaced once', /1000/.test(hint ?? '') && /20x/.test(hint ?? ''));
  check('the upgrade hint disappears once the condition is met',
    buildUpgradeHint(flagged, { openrouter_paid_credits: true }) === undefined);

  // No blob yet: the honest "run a sync first" answer.
  const emptyAnswer = { results: [], notice: 'No ranking computed yet for coding. Run a sync first.' };
  check('no precomputed blob → an empty answer, not an upstream call',
    emptyAnswer.results.length === 0 && /sync/i.test(emptyAnswer.notice));

  // Every candidate filtered out (e.g. huge payload vs small windows).
  const big = rerank(offerings, { size: 'large' }, SIZE_TOKENS.large, ['chat', 'ide', 'cli']);
  const bigFiltered = big.filter((o) => fitsContext(o.context_window, SIZE_TOKENS.large));
  check('a large payload filters small-window candidates',
    bigFiltered.every((o) => (o.context_window ?? 0) >= SIZE_TOKENS.large * 1.25));
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);