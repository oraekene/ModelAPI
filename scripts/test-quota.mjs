/**
 * Quota pool tests — mirrors src/quota.ts.
 *   node scripts/test-quota.mjs
 *
 * The extraction tests are regression tests for the anchoring-direction bug:
 * figures always PRECEDE their unit, and a $ figure is a price, never an
 * allowance.
 */

let passed = 0, failed = 0;
const check = (n, c, d = '') => {
  if (c) { passed++; console.log(`  PASS  ${n}`); }
  else { failed++; console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`); }
};

// ---- mirrors of src/quota.ts ---------------------------------------------
const UNIT_PATTERNS = [
  [/messages?\s*(?:per|\/|every)\s*5\s*h(?:ours?)?/gi, 'messages_per_5h'],
  [/requests?\s*(?:per|\/|a)\s*day|\brpd\b|daily\s*requests?/gi, 'requests_per_day'],
  [/requests?\s*(?:per|\/|a)\s*min(?:ute)?|\brpm\b/gi, 'requests_per_minute'],
  [/requests?\s*(?:per|\/|an)\s*hour|\brph\b/gi, 'requests_per_hour'],
  [/tokens?\s*(?:per|\/|a)\s*day|\btpd\b/gi, 'tokens_per_day'],
  [/tokens?\s*(?:per|\/|a)\s*min(?:ute)?|\btpm\b/gi, 'tokens_per_minute'],
];
const LOOKBACK_CHARS = 24;

function extractQuotas(text) {
  const out = [];
  for (const [pattern, unit] of UNIT_PATTERNS) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(text)) !== null) {
      const before = text.slice(Math.max(0, m.index - LOOKBACK_CHARS), m.index);
      const numMatch = /(\$?)\s*([\d][\d,]*(?:\.\d+)?)\s*([kKmM])?\s*$/.exec(before);
      if (!numMatch) continue;
      if (numMatch[1] === '$') continue;
      let value = Number(numMatch[2].replace(/,/g, ''));
      if (!Number.isFinite(value) || value <= 0) continue;
      const suffix = (numMatch[3] ?? '').toLowerCase();
      if (suffix === 'k') value *= 1_000;
      if (suffix === 'm') value *= 1_000_000;
      out.push({ unit, value, context: `${numMatch[2]}${numMatch[3] ?? ''} ${m[0]}`.trim().slice(0, 80) });
    }
  }
  return out;
}

function reconcile(candidates) {
  const byUnit = new Map();
  for (const c of candidates) {
    const list = byUnit.get(c.unit) ?? [];
    list.push(c);
    byUnit.set(c.unit, list);
  }
  const out = new Map();
  for (const [unit, list] of byUnit) {
    let best = list[0];
    for (const c of list) if (c.value < best.value) best = c;
    out.set(unit, best);
  }
  return out;
}

function sourcesDisagree(candidates, unit) {
  const vals = candidates.filter((c) => c.unit === unit).map((c) => c.value);
  if (vals.length < 2) return false;
  return Math.max(...vals) / Math.min(...vals) >= 2;
}

function stripToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

function resolveQuota(pool, userFlags = {}) {
  const conditionMet = pool.condition_key ? userFlags[pool.condition_key] === true : false;
  const value = conditionMet && pool.conditional_value !== null ? pool.conditional_value : pool.quota_value;
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

async function discoverOpenRouterQuota(apiKey, fetchImpl) {
  try {
    const res = await fetchImpl('https://openrouter.ai/api/v1/key', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return null;
    const body = await res.json();
    if (typeof body?.data?.is_free_tier !== 'boolean') return null;
    return { paidCredits: body.data.is_free_tier === false, usageDaily: body.data.usage_daily ?? 0 };
  } catch {
    return null;
  }
}

// ---- extraction: anchoring direction -------------------------------------
console.log('\nextractQuotas() — anchor on the unit, scan backwards');
{
  // The $10 bug: the price threshold must never be read as the allowance.
  const c1 = extractQuotas('accounts with less than $10 purchased get 50 requests per day');
  check('a $ threshold is never the allowance', c1.every((c) => c.value !== 10));
  check('the sentence yields the 50/day allowance', c1.some((c) => c.value === 50 && c.unit === 'requests_per_day'));

  // Two rates in one sentence: both must surface.
  const c2 = extractQuotas('free tier gets 20 requests per day, paid gets 1000 requests per day');
  const dayVals = c2.filter((c) => c.unit === 'requests_per_day').map((c) => c.value).sort((a, b) => a - b);
  check('two rates in one sentence are both found', dayVals.join() === '20,1000');

  // Formatted figures: 50,000 must not be mangled.
  const c3 = extractQuotas('Pro accounts: 50,000 requests per day');
  check('formatted numbers parse whole', c3.some((c) => c.value === 50000));

  // The 5-hour window pattern must not be shadowed by the hour pattern.
  const c4 = extractQuotas('free users get 40 messages per 5 hours');
  check('a 5-hour window reads as messages_per_5h, not per-hour',
    c4.some((c) => c.unit === 'messages_per_5h' && c.value === 40));

  // k/m suffixes.
  const c5 = extractQuotas('usage: 50k requests per day');
  check('k-suffix figures scale', c5.some((c) => c.value === 50000));

  // rpm/rph patterns.
  const c6 = extractQuotas('rate limit: 20 requests per minute and 1200 requests per hour');
  check('per-minute and per-hour both extract',
    c6.some((c) => c.unit === 'requests_per_minute' && c.value === 20) &&
    c6.some((c) => c.unit === 'requests_per_hour' && c.value === 1200));

  // The number must be within lookback of the unit.
  const c7 = extractQuotas('$10 per month. also you get 50 requests per day');
  check('a figure far from the unit phrase is not captured', c7.every((c) => c.value !== 10));

  const c8 = extractQuotas('tokens billed at $0.01; daily allowance 200,000 tokens per day');
  check('tokens-per-day extracts', c8.some((c) => c.unit === 'tokens_per_day' && c.value === 200000));
}

// ---- reconciliation -------------------------------------------------------
console.log('\nreconcile() / sourcesDisagree()');
{
  const candidates = [
    { unit: 'requests_per_day', value: 1000 },
    { unit: 'requests_per_day', value: 50 },
    { unit: 'requests_per_minute', value: 20 },
  ];
  const settled = reconcile(candidates);
  check('the smallest figure per unit wins (free allowance)', settled.get('requests_per_day').value === 50);
  check('independent units are preserved', settled.get('requests_per_minute').value === 20);

  check('2x disagreement is detected', sourcesDisagree([
    { unit: 'requests_per_day', value: 50 },
    { unit: 'requests_per_day', value: 1000 },
  ], 'requests_per_day'));
  check('sub-2x spread is not a disagreement', !sourcesDisagree([
    { unit: 'requests_per_day', value: 50 },
    { unit: 'requests_per_day', value: 80 },
  ], 'requests_per_day'));
  check('a single source cannot disagree with itself',
    !sourcesDisagree([{ unit: 'requests_per_day', value: 50 }], 'requests_per_day'));
}

// ---- live discovery -------------------------------------------------------
console.log('\ndiscoverOpenRouterQuota() — the account answers for itself');
{
  const freeRes = { ok: true, async json() { return { data: { is_free_tier: true, usage_daily: 7 } }; } };
  const paidRes = { ok: true, async json() { return { data: { is_free_tier: false, usage_daily: 210 } }; } };

  const free = await discoverOpenRouterQuota('k', async () => freeRes);
  check('an is_free_tier=true account has not paid credits',
    free?.paidCredits === false && free?.usageDaily === 7);
  const paid = await discoverOpenRouterQuota('k', async () => paidRes);
  check('an is_free_tier=false account has paid credits', paid?.paidCredits === true);

  const bad = await discoverOpenRouterQuota('k', async () => ({ ok: false, status: 401 }));
  check('an API failure returns null, never a guess', bad === null);
}

// ---- resolveQuota ---------------------------------------------------------
console.log('\nresolveQuota() — the conditional tier');
{
  const pool = {
    pool_id: 'openrouter-free', platform: 'openrouter', label: 'OpenRouter free models',
    quota_unit: 'requests_per_day', quota_value: 50,
    conditional_value: 1000, condition_key: 'openrouter_paid_credits',
    condition_note: 'after $10 lifetime credit purchase',
    is_shared: 1, confidence: 'live',
  };
  const before = resolveQuota(pool, { openrouter_paid_credits: false });
  check('without the flag the baseline allowance applies', before.value === 50);
  check('the upgrade is surfaced as a hint', /1000/.test(before.upgradeHint ?? '') && /requests per day/.test(before.upgradeHint ?? ''));
  const after = resolveQuota(pool, { openrouter_paid_credits: true });
  check('with the flag the conditional allowance applies', after.value === 1000);
  check('the hint disappears once the tier is unlocked', after.upgradeHint === undefined);
  check('a shared pool reports shared', before.shared === true);
}

// ---- syncPool -------------------------------------------------------------
console.log('\nsyncPool() — live path, tier-a path, and graceful degradation');
{
  // Live path: OpenRouter reports the account tier, the flag is recorded.
  const liveDb = {
    updates: [],
    prepare(sql) {
      return {
        bind(...args) { this.args = args; return this; },
        async run() { liveDb.updates.push({ sql, args: this.args }); },
      };
    },
  };
  const poolRow = {
    pool_id: 'openrouter-free', platform: 'openrouter', label: 'OpenRouter free models',
    quota_unit: 'requests_per_day', quota_value: 50, secondary_unit: 'requests_per_minute',
    secondary_value: 20, conditional_value: 1000, condition_key: 'openrouter_paid_credits',
    condition_note: 'after $10 lifetime credit purchase', is_shared: 1,
    source_url: 'https://openrouter.ai/docs/api_reference/limits', confidence: 'stated', notes: null,
    last_verified_at: null,
  };
  const liveFetch = async () => ({ ok: true, async json() { return { data: { is_free_tier: false, usage_daily: 12 } }; } });

  // Mirrors the live branch of syncPool().
  async function liveSync(db, pool, apiKey, fetchImpl) {
    const live = await discoverOpenRouterQuota(apiKey, fetchImpl);
    if (live) {
      await db.prepare(`UPDATE quota_pools SET confidence = 'live', last_verified_at = ?2, notes = ?3 WHERE pool_id = ?1`)
        .bind(pool.pool_id, new Date().toISOString(), 'x').run();
      await db.prepare(`UPDATE user_preferences SET openrouter_paid_credits = ?1 WHERE user_id IS NOT NULL`)
        .bind(live.paidCredits ? 1 : 0).run();
      return { method: 'live', value: live.paidCredits ? pool.conditional_value : pool.quota_value, confidence: 'live' };
    }
    return null;
  }

  const liveReport = await liveSync(liveDb, poolRow, 'key', liveFetch);
  check('the live path reads the account tier', liveReport?.method === 'live');
  check('a paid-credit account resolves the conditional 1000', liveReport?.value === 1000);
  check('the paid-credit flag is written for every user row',
    liveDb.updates.some((u) => /user_preferences/.test(u.sql) && u.args[0] === 1));

  // Tier-a path: docs page fetch + extraction.
  const docsHtml = '<html><body><h1>Rate limits</h1><p>free accounts with less than $10 purchased get 50 requests per day</p><script>bad()</script></body></html>';
  const tierFetch = async () => ({ ok: true, async text() { return docsHtml; } });
  async function tierASync(pool, fetchImpl) {
    const res = await fetchImpl(pool.source_url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = stripToText(await res.text());
    const candidates = extractQuotas(text);
    const reconciled = reconcile(candidates);
    const primary = pool.quota_unit ? reconciled.get(pool.quota_unit) : undefined;
    if (!primary) throw new Error('no quota figure found');
    return { method: 'tier-a', unit: primary.unit, value: primary.value, confidence: 'stated' };
  }
  const tierReport = await tierASync(poolRow, tierFetch);
  check('the tier-a path extracts from docs HTML', tierReport?.method === 'tier-a' && tierReport?.value === 50);

  // Degradation: a failed fetch leaves the value intact, marked stale.
  async function degrade(pool, fetchImpl) {
    try {
      const res = await fetchImpl(pool.source_url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { ok: true };
    } catch (err) {
      return { ok: false, note: String(err.message), value: pool.quota_value, confidence: 'stale' };
    }
  }
  const degraded = await degrade(poolRow, async () => { throw new Error('network down'); });
  check('a failure degrades to stale and KEEPS the previous value',
    degraded.ok === false && degraded.confidence === 'stale' && degraded.value === 50);
}

// ---- groq embedded table + google pricing page ------------------------------
console.log('\ngroq flight payload and google pricing page — mirrors of quota.ts');
{
  // Mirrors parseGroqRateTable() + groqCell().
  const groqCell = (v) => {
    if (v === '-' || v === null || v === undefined) return null;
    const s = String(v).trim();
    if (!/^[\d,.]+[kKmM]?$/.test(s)) return null;
    const mult = s.endsWith('K') ? 1_000 : s.endsWith('M') ? 1_000_000 : 1;
    const n = Number(s.replace(/[kKmM,]/g, ''));
    return Number.isFinite(n) && n > 0 ? n * mult : null;
  };
  const parseGroqRateTable = (html) => {
    const flight = html.replaceAll('\\"', '"').replaceAll('&quot;', '"').replaceAll('&amp;', '&');
    const marker = '"title":"MODEL ID"';
    const markerIdx = flight.indexOf(marker);
    if (markerIdx === -1) return [];
    const rowsStart = flight.lastIndexOf('[[', markerIdx);
    const rowsEnd = flight.indexOf(']],"headers"', rowsStart);
    if (rowsStart === -1 || rowsEnd === -1 || rowsEnd <= rowsStart) return [];
    let raw;
    try { raw = JSON.parse(flight.slice(rowsStart, rowsEnd + 2)); } catch { return []; }
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const row of raw) {
      if (!Array.isArray(row) || typeof row[0] !== 'string') continue;
      out.push({ model: row[0], rpm: groqCell(row[1]), rpd: groqCell(row[2]), tpm: groqCell(row[3]), tpd: groqCell(row[4]) });
    }
    return out;
  };

  const groqFlight = '<html><script>self.__next_f.push([1,"x"])</script><script>self.__next_f.push([2,"' +
    '[["llama-3.3-70b-versatile","1K","500K","300K","-"],' +
    '["openai/gpt-oss-20b","1K","500K","250K","-"],' +
    '["meta-llama/llama-prompt-guard-2-22m","100","50K","30K","-"],' +
    '["groq/compound","200","20K","200K","-"]],' +
    '"headers":[{"title":"MODEL ID","className":"min-w-[300px]"},{"title":"RPM","tooltip":"Requests per minute","className":"min-w-10"},{"title":"RPD","tooltip":"Requests per day","className":"min-w-10"},{"title":"TPM","tooltip":"Tokens per minute","className":"min-w-10"},{"title":"TPD","tooltip":"Tokens per day","className":"min-w-10"},{"title":"ASH","tooltip":"Audio seconds per hour","className":"min-w-10"},{"title":"ASD","tooltip":"Audio seconds per day","className":"min-w-10"}]]"])</script></html>';

  const groqRows = parseGroqRateTable(groqFlight);
  check('the flight payload yields one row per model', groqRows.length === 4);
  check('k-suffixed figures expand (1K RPM = 1000)', groqRows[0].rpm === 1000);
  check('500K RPD expands to 500000', groqRows[0].rpd === 500000);
  check('every row keeps its model slug', groqRows.every((r) => r.model.includes('/') || r.model.startsWith('llama')));

  const groqRpds = groqRows.map((r) => r.rpd).filter((v) => v !== null);
  const groqRpdMin = Math.min(...groqRpds);
  check('the pool value is the smallest RPD on the page (20K)', groqRpdMin === 20000);

  // Mirrors the groq branch of syncPool(): pool row gets the floor + observations.
  const groqDb = { rows: [], prepare(sql) { return { bind(...args) { this.args = args; return this; }, async run() { groqDb.rows.push({ sql, args: this.args }); } }; } };
  async function groqSync(db, pool, fetchImpl) {
    const res = await fetchImpl(pool.source_url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = parseGroqRateTable(await res.text());
    const rpds = rows.map((r) => r.rpd).filter((v) => v !== null);
    if (rows.length === 0 || rpds.length === 0) return null;
    const minRpd = Math.min(...rpds);
    await db.prepare(`UPDATE quota_pools SET quota_unit='requests_per_day', quota_value=?2 WHERE pool_id=?1`)
      .bind(pool.pool_id, minRpd).run();
    return { method: 'tier-a', value: minRpd };
  }
  const groqPool = { pool_id: 'groq-free', platform: 'groq', quota_unit: 'requests_per_day', source_url: 'https://console.groq.com/docs/rate-limits' };
  const groqReport = await groqSync(groqDb, groqPool, async () => ({ ok: true, async text() { return groqFlight; } }));
  check('the groq branch lands a tier-a value', groqReport?.method === 'tier-a' && groqReport?.value === 20000);
  check('the groq pool row is updated with the floor', groqDb.rows.some((r) => /quota_value=\?2/.test(r.sql) && r.args[1] === 20000));
  check('a page without the flight payload returns null (falls through)',
    parseGroqRateTable('<html><body>no table here</body></html>').length === 0);

  // Google pricing page: server-rendered free-tier RPD, conservative min wins.
  const googlePricing = '<html><body>' +
    '<td>Grounding with Google Search</td><td>Not available</td><td>1,500 RPD (free), then $35 / 1,000 grounded prompts</td>' +
    '<td>Grounding with Google Maps</td><td>Not available</td><td>10,000 RPD (free), then $25 / 1,000 grounded prompts</td>' +
    '<td>Grounding with Google Search</td><td>Free of charge, up to 500 RPD (limit shared with Flash-Lite RPD)</td>' +
    '</body></html>';
  const googleCandidates = extractQuotas(stripToText(googlePricing));
  const googleReconciled = reconcile(googleCandidates);
  check('the pricing page yields RPD candidates', googleCandidates.some((c) => c.unit === 'requests_per_day'));
  check('$35 is treated as a price, never an allowance', googleCandidates.every((c) => c.value !== 35));
  check('reconcile takes the conservative 500 RPD free tier', googleReconciled.get('requests_per_day')?.value === 500);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);