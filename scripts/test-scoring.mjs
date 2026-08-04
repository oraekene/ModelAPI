/**
 * Scoring tests — mirrors src/scoring.ts.
 *   node scripts/test-scoring.mjs
 *
 * Plain Node, no framework, matching the repo's existing test style.
 * Focus: missing-term renormalisation and scale-aware normalisation — the two
 * behaviours the design depends on and the bugs the tests caught.
 */

let passed = 0, failed = 0;
const check = (n, c, d = '') => {
  if (c) { passed++; console.log(`  PASS  ${n}`); }
  else { failed++; console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`); }
};

// ---- mirrors of src/scoring.ts -------------------------------------------
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
    const w = weights[k] / weightSum;
    effectiveWeights[k] = w;
    score += w * v;
  }
  return { score, basis: terms.map(([k]) => k), effectiveWeights };
}

const BENCHMARK_SCALES = {
  aa_intelligence_index: [0, 100],
  aa_coding_index: [0, 100],
  aa_agentic_index: [0, 100],
  terminal_bench_2_0: [0, 1],
  terminal_bench_2_1: [0, 1],
};
const MIN_CANDIDATES_FOR_MINMAX = 5;

function normalise(values, benchmark = undefined) {
  const present = values.filter((v) => v !== null);
  if (present.length === 0) return values.map(() => null);
  const knownScale = benchmark ? BENCHMARK_SCALES[benchmark] : undefined;
  if (knownScale) {
    const [lo, hi] = knownScale;
    const span = hi - lo;
    return values.map((v) => v === null ? null : Math.max(0, Math.min(100, ((v - lo) / span) * 100)));
  }
  if (present.length < MIN_CANDIDATES_FOR_MINMAX) return values.map((v) => (v === null ? null : 50));
  const min = Math.min(...present);
  const max = Math.max(...present);
  const spread = max - min;
  if (spread === 0) return values.map((v) => (v === null ? null : 50));
  return values.map((v) => (v === null ? null : ((v - min) / spread) * 100));
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

const r1 = (x) => Math.round(x * 10) / 10;

// ---- composite: renormalisation ------------------------------------------
console.log('\ncomposite() — missing terms are dropped, weights renormalised');
{
  const full = composite({ quality: 80, harness: 60, quota: 50, speed: 70 });
  check('all four terms present: basis reports all', full.basis.length === 4);

  const fullSum = Object.values(full.effectiveWeights).reduce((a, b) => a + b, 0);
  check('all four terms present: effective weights sum to 1',
    Math.abs(fullSum - 1) < 1e-9);

  const noH = composite({ quality: 80, harness: null, quota: 50, speed: null });
  check('null harness and speed are excluded from basis',
    noH.basis.join() === 'quality,quota');

  const noHSum = Object.values(noH.effectiveWeights).reduce((a, b) => a + b, 0);
  check('renormalised weights still sum to 1', Math.abs(noHSum - 1) < 1e-9);

  check('quality keeps the majority share when alone',
    r1(noH.effectiveWeights.quality) === r1(0.55 / 0.70));

  const onlyQ = composite({ quality: 42, harness: null, quota: null, speed: null });
  check('single term score is that term', onlyQ.score === 42);
  check('single term basis is just quality', onlyQ.basis[0] === 'quality');

  const none = composite({ quality: null, harness: null, quota: null, speed: null });
  check('all null → score 0 and empty basis', none.score === 0 && none.basis.length === 0);

  const zeroWeights = composite({ quality: 1, harness: 1, quota: 1, speed: 1 },
    { quality: 0, harness: 0, quota: 0, speed: 0 });
  check('all-zero weights are refused, not divided by zero',
    zeroWeights.score === 0 && zeroWeights.basis.length === 0);
}

// ---- normalisation: the scale-aware fix ----------------------------------
console.log('\nnormalise() — scale-aware, no invented 100-point gaps');
{
  // The bug: two candidates 7 apart on a 0-100 index must NOT come out 100 apart.
  const known = normalise([88, 95], 'aa_coding_index');
  check('known scale is absolute: 88 stays 88, not 0', known[0] === 88);
  check('known scale is absolute: 95 stays 95, not 100', known[1] === 95);
  check('two close models keep a close gap', (known[1] - known[0]) === 7);

  const clamped = normalise([-5, 105], 'aa_intelligence_index');
  check('known scale clamps to 0-100', clamped[0] === 0 && clamped[1] === 100);

  const tb = normalise([0.517, 0.631], 'terminal_bench_2_0');
  check('terminal-bench 0-1 scale maps to 0-100',
    r1(tb[0]) === 51.7 && r1(tb[1]) === 63.1);

  // Unknown scale with >=5 candidates: minmax is legitimate.
  const elo = normalise([1200, 1300, 1400, 1500, 1600]);
  check('unknown scale, >=5 candidates: minmax fills 0-100',
    elo[0] === 0 && elo[4] === 100);

  // Unknown scale, too few candidates: refuse to rank, return 50.
  const few = normalise([1200, 1300, 1400]);
  check('unknown scale, <5 candidates: neutral 50, no invented gap',
    few.every((v) => v === 50));

  const flat = normalise([50, 50, 50, 50, 50, 50], undefined);
  check('a flat field reads as 50, not uniformly bad', flat.every((v) => v === 50));

  const mixedNull = normalise([null, 40, 60], 'aa_coding_index');
  check('null entries stay null through known-scale normalisation',
    mixedNull[0] === null && mixedNull[1] === 40);

  const allNull = normalise([null, null]);
  check('all-null input returns all-null, not zeroes', allNull.every((v) => v === null));
}

// ---- quota sufficiency ---------------------------------------------------
console.log('\nquotaSufficiency() — the term the v1 design was missing');
{
  check('50/day vs 30-call session: 83', r1(quotaSufficiency(50, 'requests_per_day', 30)) === 83.3);
  check('1000/day vs 30 calls: saturated at 100 (not 1666)',
    quotaSufficiency(1000, 'requests_per_day', 30) === 100);
  check('a small 3-call task is easily served by 50/day',
    quotaSufficiency(50, 'requests_per_day', 3) === 100);
  check('an agent run (150 calls) is not served by 50/day',
    r1(quotaSufficiency(50, 'requests_per_day', 150)) === 16.7);
  check('per-hour units convert up', r1(quotaSufficiency(60, 'requests_per_hour', 30)) === 100);
  check('messages-per-5h window is one session',
    r1(quotaSufficiency(40, 'messages_per_5h', 40)) === 100);
  check('tokens/day converts via 4k tokens per call',
    quotaSufficiency(200000, 'tokens_per_day', 25) === 100);
  check('unknown quota is null, not a guess',
    quotaSufficiency(null, 'requests_per_day', 30) === null);
  check('unknown unit is null, not ignoread',
    quotaSufficiency(100, 'foobars_per_quark', 30) === null);
}

console.log('\nestimateCalls() — by task shape');
{
  check('small = 3', estimateCalls('small') === 3);
  check('medium = 30', estimateCalls('medium') === 30);
  check('large = 80', estimateCalls('large') === 80);
  check('agent = 150', estimateCalls('agent') === 150);
}

// ---- end-to-end: quota can rescue, up to a point --------------------------
console.log('\nend-to-end — the intended asymmetry');
{
  const est = 30;
  // A is 4 quality points ahead but on a 50/day cap; B is behind but has 20x.
  const aSuff = quotaSufficiency(50, 'requests_per_day', est);     // 83.3
  const bSuff = quotaSufficiency(1000, 'requests_per_day', est);   // 100
  const aScore = composite({ quality: 90, harness: null, quota: aSuff, speed: null }).score;
  const bScore = composite({ quality: 86, harness: null, quota: bSuff, speed: null }).score;

  check('4 points behind quality but 20x quota OVERTAKES',
    bScore > aScore, `expected ${bScore} > ${aScore}`);
  check('the winning margin is thin, not a blowout',
    Math.abs(bScore - aScore) < 5);

  // A model 45 quality points behind is beyond rescue.
  const cScore = composite({ quality: 45, harness: null, quota: bSuff, speed: null }).score;
  check('45 points behind is NOT rescued by quota', aScore > cScore, `expected ${aScore} > ${cScore}`);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);