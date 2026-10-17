/**
 * Per-key caps tests - mirrors src/caps.ts (keep the two in sync).
 *   node scripts/test-caps.mjs
 */

let passed = 0, failed = 0;
const check = (n, c, d = '') => {
  if (c) { passed++; console.log(`  PASS  ${n}`); }
  else { failed++; console.log(`  FAIL  ${n}${d ? ' - ' + d : ''}`); }
};

// ---------------------------------------------------------------------------
// Mirror of src/caps.ts + the core of resolveQuota (quota.ts)
// ---------------------------------------------------------------------------

function normalisePlatform(raw) {
  const p = String(raw ?? '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-_.]{0,63}$/.test(p) ? p : null;
}

function utcDay(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function normaliseUsage(v) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1e9) return null;
  return Math.floor(n);
}

function resolveQuota(pool, userFlags = {}) {
  const conditionMet = pool.condition_key ? userFlags[pool.condition_key] === true : false;
  const value = conditionMet && pool.conditional_value !== null ? pool.conditional_value : pool.quota_value;
  return { unit: pool.quota_unit, value, upgradeHint: undefined };
}

function capsFor(keys, pools, usage, userFlags = {}) {
  const headline = new Map();
  for (const pool of pools) {
    const current = headline.get(pool.platform);
    if (!current || (pool.quota_value ?? -1) > (current.quota_value ?? -1)) headline.set(pool.platform, pool);
  }
  const usedByKey = new Map(usage.map((u) => [u.key_id, u]));
  return keys.map((k) => {
    const pool = headline.get(k.platform);
    const resolved = pool ? resolveQuota(pool, userFlags) : null;
    const u = usedByKey.get(k.key_id);
    const usedRequests = u?.requests ?? 0;
    const usedTokens = u?.tokens ?? 0;
    const tokenUnit = (resolved?.unit ?? '').includes('token');
    const used = tokenUnit ? usedTokens : usedRequests;
    const remaining = resolved?.value != null ? Math.max(0, resolved.value - used) : null;
    return {
      keyId: k.key_id, platform: k.platform, label: k.label,
      unit: resolved?.unit ?? null, allowance: resolved?.value ?? null,
      usedRequests, usedTokens, remaining, upgradeHint: resolved?.upgradeHint,
    };
  });
}

// ---------------------------------------------------------------------------
// Mock D1 - simulates the exact queries src/caps.ts issues
// ---------------------------------------------------------------------------

class MockDB {
  constructor({ keys = [], pools = [], usage = [] } = {}) {
    this.keys = keys;
    this.pools = pools;
    this.usage = usage;
    this.writes = [];
  }

  prepare(sql) {
    const db = this;
    const stmt = {
      _params: [],
      bind(...params) { stmt._params = params; return stmt; },
      async first() {
        if (sql.includes('SELECT key_id FROM user_api_keys')) {
          const [keyId, userId] = stmt._params;
          return db.keys.find((k) => k.key_id === keyId && k.user_id === userId && !k.revoked_at) ?? null;
        }
        return null;
      },
      async all() {
        if (sql.includes('FROM user_api_keys')) {
          const [userId] = stmt._params;
          return { results: db.keys.filter((k) => k.user_id === userId && !k.revoked_at) };
        }
        if (sql.includes('FROM quota_pools')) return { results: db.pools };
        if (sql.includes('FROM key_usage')) {
          const [day] = stmt._params;
          const ids = stmt._params.slice(1);
          return { results: db.usage.filter((u) => u.day === day && ids.includes(u.key_id)) };
        }
        return { results: [] };
      },
      async run() {
        db.writes.push({ sql, params: stmt._params });
        let changes = 0;
        if (sql.includes('INSERT INTO user_api_keys')) {
          const [keyId, userId, platform, label, createdAt] = stmt._params;
          db.keys.push({ key_id: keyId, user_id: userId, platform, label, created_at: createdAt, revoked_at: null });
          changes = 1;
        } else if (sql.includes('UPDATE user_api_keys')) {
          const [keyId, userId, revokedAt] = stmt._params;
          const row = db.keys.find((k) => k.key_id === keyId && k.user_id === userId && !k.revoked_at);
          if (row) { row.revoked_at = revokedAt; changes = 1; }
        } else if (sql.includes('INSERT INTO key_usage')) {
          const [keyId, day, requests, tokens] = stmt._params;
          const row = db.usage.find((u) => u.key_id === keyId && u.day === day);
          if (row) { row.requests += requests; row.tokens += tokens; }
          else db.usage.push({ key_id: keyId, day, requests, tokens });
          changes = 1;
        }
        return { success: true, meta: { changes } };
      },
    };
    return stmt;
  }
}

// Mirror of the D1 helpers, verbatim logic
async function createKey(db, userId, platform, label = '') {
  const keyId = 'test-uuid';
  await db.prepare(
    `INSERT INTO user_api_keys (key_id, user_id, platform, label, created_at, revoked_at)
     VALUES (?1, ?2, ?3, ?4, ?5, NULL)`,
  ).bind(keyId, userId, platform, label, new Date().toISOString()).run();
  return keyId;
}

async function listKeys(db, userId) {
  const res = await db.prepare(
    `SELECT key_id, user_id, platform, label, created_at, revoked_at
       FROM user_api_keys WHERE user_id = ?1 AND revoked_at IS NULL ORDER BY created_at, key_id`,
  ).bind(userId).all();
  return res.results ?? [];
}

async function revokeKey(db, userId, keyId) {
  const res = await db.prepare(
    `UPDATE user_api_keys SET revoked_at = ?3 WHERE key_id = ?1 AND user_id = ?2 AND revoked_at IS NULL`,
  ).bind(keyId, userId, new Date().toISOString()).run();
  return (res.meta?.changes ?? 0) > 0;
}

async function recordUsage(db, userId, keyId, requests, tokens, day = utcDay()) {
  const owned = await db.prepare(
    `SELECT key_id FROM user_api_keys WHERE key_id = ?1 AND user_id = ?2 AND revoked_at IS NULL`,
  ).bind(keyId, userId).first();
  if (!owned) return false;
  await db.prepare(
    `INSERT INTO key_usage (key_id, day, requests, tokens, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(key_id, day) DO UPDATE SET
       requests = requests + excluded.requests,
       tokens = tokens + excluded.tokens,
       updated_at = excluded.updated_at`,
  ).bind(keyId, day, requests, tokens, new Date().toISOString()).run();
  return true;
}

async function userCaps(db, userId, userFlags = {}) {
  const keys = await listKeys(db, userId);
  if (keys.length === 0) return [];
  const pools = (await db.prepare(`SELECT * FROM quota_pools`).all()).results ?? [];
  const placeholders = keys.map((_, i) => `?${i + 2}`).join(',');
  const usage = (await db.prepare(
    `SELECT key_id, day, requests, tokens FROM key_usage WHERE day = ?1 AND key_id IN (${placeholders})`,
  ).bind(utcDay(), ...keys.map((k) => k.key_id)).all()).results ?? [];
  return capsFor(keys, pools, usage, userFlags);
}

const pool = (over = {}) => ({
  pool_id: 'groq-free', platform: 'groq', label: 'free',
  quota_unit: 'requests_per_day', quota_value: 1000,
  conditional_value: null, condition_key: null, condition_note: null,
  is_shared: 1, confidence: 'strong', ...over,
});

const keyRow = (keyId, platform, over = {}) => ({
  key_id: keyId, user_id: 'u1', platform, label: '', created_at: '2026-10-17T00:00:00Z',
  revoked_at: null, ...over,
});

// ---------------------------------------------------------------------------
// Pure input sanitising
// ---------------------------------------------------------------------------

check('platform lowercased and trimmed', normalisePlatform('  GROQ ') === 'groq');
check('platform allows hyphen/underscore/dot', normalisePlatform('google-ai_studio.v2') !== null);
check('platform rejects empty', normalisePlatform('') === null);
check('platform rejects spaces', normalisePlatform('a b') === null);
check('platform rejects leading dash', normalisePlatform('-x') === null);

check('usage accepts a number', normaliseUsage(5) === 5);
check('usage accepts a numeric string', normaliseUsage('42') === 42);
check('usage floors fractions', normaliseUsage(3.9) === 3);
check('usage rejects negative', normaliseUsage(-1) === null);
check('usage rejects NaN', normaliseUsage('abc') === null);
check('usage rejects Infinity', normaliseUsage(Infinity) === null);
check('usage rejects beyond ceiling', normaliseUsage(2e9) === null);

check('utcDay is a bare UTC date', /^\d{4}-\d{2}-\d{2}$/.test(utcDay(new Date('2026-10-17T23:59:00Z'))));
check('utcDay uses UTC, not local', utcDay(new Date('2026-10-17T23:59:00Z')) === '2026-10-17');

// ---------------------------------------------------------------------------
// capsFor - the math
// ---------------------------------------------------------------------------

{
  const caps = capsFor([keyRow('k1', 'groq')], [pool()], []);
  check('no usage means full allowance', caps[0].remaining === 1000 && caps[0].usedRequests === 0);
}

{
  const caps = capsFor([keyRow('k1', 'groq')], [pool()], [{ key_id: 'k1', day: utcDay(), requests: 240, tokens: 999 }]);
  check('recorded requests subtract from requests unit', caps[0].remaining === 760);
  check('tokens still reported for the record', caps[0].usedTokens === 999);
}

{
  const caps = capsFor([keyRow('k1', 'groq')], [pool()], [{ key_id: 'k1', day: utcDay(), requests: 1200, tokens: 0 }]);
  check('overuse clamps at zero', caps[0].remaining === 0);
}

{
  const caps = capsFor(
    [keyRow('k1', 'meta')],
    [pool({ platform: 'meta', quota_unit: 'tokens_per_day', quota_value: 100000 })],
    [{ key_id: 'k1', day: utcDay(), requests: 50, tokens: 60000 }],
  );
  check('token-unit pool subtracts tokens, not requests', caps[0].remaining === 40000);
}

{
  const caps = capsFor(
    [keyRow('k1', 'openrouter')],
    [pool({ platform: 'openrouter', quota_unit: 'requests_per_day', quota_value: 50, conditional_value: 1000, condition_key: 'openrouter_paid_credits' })],
    [{ key_id: 'k1', day: utcDay(), requests: 10 }],
  );
  check('without the flag the baseline tier applies', caps[0].allowance === 50 && caps[0].remaining === 40);
  const caps2 = capsFor(
    [keyRow('k1', 'openrouter')],
    [pool({ platform: 'openrouter', quota_unit: 'requests_per_day', quota_value: 50, conditional_value: 1000, condition_key: 'openrouter_paid_credits' })],
    [{ key_id: 'k1', day: utcDay(), requests: 10 }],
    { openrouter_paid_credits: true },
  );
  check('with the flag the conditional tier applies', caps2[0].allowance === 1000 && caps2[0].remaining === 990);
}

{
  const caps = capsFor(
    [keyRow('k1', 'groq'), keyRow('k2', 'groq')],
    [pool()],
    [{ key_id: 'k1', day: utcDay(), requests: 990 }],
  );
  check('two keys have independent allowances', caps[0].remaining === 10 && caps[1].remaining === 1000);
}

{
  const caps = capsFor([keyRow('k1', 'mystery')], [pool()], []);
  check('unknown platform gets null allowance, never a guess', caps[0].allowance === null && caps[0].remaining === null && caps[0].unit === null);
}

{
  const caps = capsFor(
    [keyRow('k1', 'zzz')],
    [pool({ platform: 'zzz', quota_value: 10, quota_unit: 'requests_per_day' }), pool({ pool_id: 'zzz-pro', platform: 'zzz', quota_value: 500, quota_unit: 'requests_per_day' })],
    [],
  );
  check('headline pool is the largest baseline', caps[0].allowance === 500);
}

// ---------------------------------------------------------------------------
// D1 flows - ownership, soft delete, accumulation
// ---------------------------------------------------------------------------

{
  const db = new MockDB({ keys: [keyRow('k1', 'groq')] });
  const ok = await recordUsage(db, 'u1', 'k1', 5, 0);
  const ok2 = await recordUsage(db, 'u1', 'k1', 7, 3);
  check('recordUsage accepts the owner', ok === true);
  check('recordUsage accumulates on conflict', db.usage[0].requests === 12 && db.usage[0].tokens === 3);
}

check('recordUsage refuses a foreign key', (await recordUsage(new MockDB({ keys: [keyRow('k1', 'groq')] }), 'other', 'k1', 1, 0)) === false);
check('recordUsage refuses a revoked key', (await recordUsage(new MockDB({ keys: [keyRow('k1', 'groq', { revoked_at: 'x' })] }), 'u1', 'k1', 1, 0)) === false);

{
  const db = new MockDB({ keys: [keyRow('k1', 'groq'), keyRow('k2', 'groq', { revoked_at: 'x' })] });
  const listed = await listKeys(db, 'u1');
  check('listKeys hides revoked keys', listed.length === 1 && listed[0].key_id === 'k1');
}

{
  const db = new MockDB({ keys: [keyRow('k1', 'groq')] });
  check('revokeKey revokes an owned live key', (await revokeKey(db, 'u1', 'k1')) === true);
  check('revokeKey is not repeatable', (await revokeKey(db, 'u1', 'k1')) === false);
  check('revokeKey refuses a foreign key', (await revokeKey(db, 'other', 'k1')) === false);
}

{
  const db = new MockDB({ keys: [keyRow('k1', 'groq')], pools: [pool()] });
  const keyId = await createKey(db, 'u1', 'groq', 'work');
  check('createKey inserts a live key', db.keys.some((k) => k.label === 'work' && !k.revoked_at));
  await recordUsage(db, 'u1', keyId, 100, 0);
  const caps = await userCaps(db, 'u1');
  check('userCaps joins keys, pools and today usage', caps.length === 2 && caps[1].remaining === 900);
}

{
  const db = new MockDB({ keys: [keyRow('k1', 'groq')], pools: [pool()], usage: [{ key_id: 'k1', day: '2000-01-01', requests: 400, tokens: 0 }] });
  const caps = await userCaps(db, 'u1');
  check('yesterday usage does not count against today', caps[0].remaining === 1000);
}

check('userCaps is empty for a user with no keys', (await userCaps(new MockDB(), 'u1')).length === 0);

{
  const db = new MockDB();
  await createKey(db, 'other', 'groq');
  check('a foreign user sees none of it', (await userCaps(db, 'u1')).length === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
