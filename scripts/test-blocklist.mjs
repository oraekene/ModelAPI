/**
 * Blocklist tests - mirrors src/scrapers/blocklist.ts (keep the two in sync).
 *   node scripts/test-blocklist.mjs
 */

let passed = 0, failed = 0;
const check = (n, c, d = '') => {
  if (c) { passed++; console.log(`  PASS  ${n}`); }
  else { failed++; console.log(`  FAIL  ${n}${d ? ' - ' + d : ''}`); }
};

// ---------------------------------------------------------------------------
// Mirror of src/scrapers/blocklist.ts (pure rules)
// ---------------------------------------------------------------------------

const BLOCK_AFTER_FAILURES = 3;
const BLOCK_TTL_DAYS = 7;

function decideBlockAction(health, blocked, now) {
  if (!health) return 'none';
  const failures = health.consecutive_failures ?? 0;
  const expired = blocked ? new Date(blocked.expires_at).getTime() <= now.getTime() : false;

  if (blocked) {
    if (health.last_status === 'ok' && failures === 0) return 'unblock';
    if (expired && failures >= BLOCK_AFTER_FAILURES) return 'refresh';
    return 'none';
  }
  return failures >= BLOCK_AFTER_FAILURES ? 'block' : 'none';
}

function isBlockedNow(blocked, now) {
  if (!blocked) return false;
  return new Date(blocked.expires_at).getTime() > now.getTime();
}

function plusDays(from, days) {
  return new Date(from.getTime() + days * 86_400_000).toISOString();
}

// ---------------------------------------------------------------------------
// Mock D1 (supports .all() + the writes reconcile/load issue)
// ---------------------------------------------------------------------------

class MockDB {
  constructor({ health = [], blocked = [] } = {}) {
    this.health = health;
    this.blocked = blocked;
    this.writes = [];
  }

  prepare(sql) {
    const db = this;
    const stmt = {
      _params: [],
      bind(...params) { stmt._params = params; return stmt; },
      async all() {
        if (sql.includes('FROM scraper_health')) return { results: db.health };
        if (sql.includes('FROM scraper_blocklist') && sql.includes('WHERE expires_at >')) {
          const cutoff = stmt._params[0];
          return { results: db.blocked.filter((r) => r.expires_at > cutoff) };
        }
        if (sql.includes('FROM scraper_blocklist')) return { results: db.blocked };
        return { results: [] };
      },
      async run() { db.writes.push({ sql, params: stmt._params }); return { success: true }; },
    };
    return stmt;
  }

  async batch(statements) {
    for (const s of statements) await s.run();
    return { success: true };
  }
}

// ---------------------------------------------------------------------------
// Pure rule tests
// ---------------------------------------------------------------------------

console.log('decideBlockAction');
{
  const now = new Date('2026-10-16T00:00:00Z');
  const past = new Date('2026-10-01T00:00:00Z').toISOString();
  const future = new Date('2026-10-20T00:00:00Z').toISOString();
  const failing = (n) => ({ scraper_id: 'x', last_status: 'error', last_error: 'HTTP 404', consecutive_failures: n });
  const ok = { scraper_id: 'x', last_status: 'ok', last_error: null, consecutive_failures: 0 };

  check('no health row -> none', decideBlockAction(undefined, null, now) === 'none');
  check('2 failures -> none', decideBlockAction(failing(2), null, now) === 'none');
  check('3 failures, never blocked -> block', decideBlockAction(failing(3), null, now) === 'block');
  check('5 failures, never blocked -> block', decideBlockAction(failing(5), null, now) === 'block');
  check('recovered + blocked -> unblock', decideBlockAction(ok, { expires_at: future }, now) === 'unblock');
  check('blocked, not expired, still failing -> none', decideBlockAction(failing(4), { expires_at: future }, now) === 'none');
  check('blocked, expired, still failing -> refresh', decideBlockAction(failing(4), { expires_at: past }, now) === 'refresh');
  check('blocked, expired, recovered -> unblock', decideBlockAction(ok, { expires_at: past }, now) === 'unblock');
  check('ok but never blocked -> none', decideBlockAction(ok, null, now) === 'none');
}

console.log('isBlockedNow');
{
  const now = new Date('2026-10-16T00:00:00Z');
  check('future expiry -> blocked', isBlockedNow({ expires_at: '2026-10-20T00:00:00Z' }, now) === true);
  check('past expiry -> not blocked', isBlockedNow({ expires_at: '2026-10-01T00:00:00Z' }, now) === false);
  check('null row -> not blocked', isBlockedNow(null, now) === false);
}

console.log('plusDays');
{
  const from = new Date('2026-10-16T00:00:00Z');
  check('adds 7 days', plusDays(from, BLOCK_TTL_DAYS) === '2026-10-23T00:00:00.000Z', plusDays(from, BLOCK_TTL_DAYS));
}

// ---------------------------------------------------------------------------
// reconcileBlocklist / loadBlockedIds flows (mirroring the SQL effects)
// ---------------------------------------------------------------------------

console.log('reconcileBlocklist');
{
  const now = new Date('2026-10-16T00:00:00Z');
  const past = '2026-10-01T00:00:00Z';
  const future = '2026-10-20T00:00:00Z';

  const db = new MockDB({
    health: [
      { scraper_id: 'dead-api', last_status: 'error', last_error: 'HTTP 404', consecutive_failures: 3 },
      { scraper_id: 'recovered', last_status: 'ok', last_error: null, consecutive_failures: 0 },
      { scraper_id: 'still-dead', last_status: 'error', last_error: 'HTTP 410', consecutive_failures: 6 },
      { scraper_id: 'flaky', last_status: 'error', last_error: 'timeout', consecutive_failures: 2 },
    ],
    blocked: [
      { scraper_id: 'recovered', blocked_at: past, reason: 'old', failures: 4, expires_at: future },
      { scraper_id: 'still-dead', blocked_at: past, reason: 'old', failures: 4, expires_at: past },
    ],
  });

  const counts = await reconcileBlocklistMirror(db, now);
  check('one block', counts.block === 1, JSON.stringify(counts));
  check('one unblock', counts.unblock === 1, JSON.stringify(counts));
  check('one refresh', counts.refresh === 1, JSON.stringify(counts));
  check('one none', counts.none === 1, JSON.stringify(counts));

  const sqlOf = (marker) => db.writes.filter((w) => w.sql.includes(marker));
  const insert = sqlOf('INSERT INTO scraper_blocklist');
  check('blocked the 3-failure scraper', insert.length === 1 && insert[0].params[0] === 'dead-api', JSON.stringify(insert.map((w) => w.params[0])));
  check('block row carries reason + expiry', insert[0].params[2] === 'HTTP 404' && insert[0].params[4] === plusDays(now, BLOCK_TTL_DAYS));
  const del = sqlOf('DELETE FROM scraper_blocklist');
  check('unblocked the recovered scraper', del.length === 1 && del[0].params[0] === 'recovered');
  const upd = sqlOf('UPDATE scraper_blocklist');
  check('refreshed the still-dead scraper', upd.length === 1 && upd[0].params[0] === 'still-dead' && upd[0].params[1] === plusDays(now, BLOCK_TTL_DAYS), JSON.stringify(upd.map((w) => w.params)));
  check('flaky (2 failures) untouched', !db.writes.some((w) => w.params[0] === 'flaky'));
}

console.log('loadBlockedIds');
{
  const now = new Date('2026-10-16T00:00:00Z');
  const db = new MockDB({
    blocked: [
      { scraper_id: 'still-blocked', blocked_at: 'x', reason: 'r', failures: 3, expires_at: '2026-10-20T00:00:00Z' },
      { scraper_id: 'expired', blocked_at: 'x', reason: 'r', failures: 3, expires_at: '2026-10-01T00:00:00Z' },
    ],
  });
  const ids = await loadBlockedIdsMirror(db, now);
  check('returns only unexpired blocks', ids.has('still-blocked') && !ids.has('expired'), [...ids].join(','));
}

// Mirror of reconcileBlocklist (identical rule flow + SQL shape)
async function reconcileBlocklistMirror(db, now) {
  const health = await db.prepare(`SELECT scraper_id, last_status, last_error, consecutive_failures FROM scraper_health`).all();
  const blocked = await db.prepare(`SELECT scraper_id, blocked_at, reason, failures, expires_at FROM scraper_blocklist`).all();
  const blockedById = new Map(blocked.results.map((r) => [r.scraper_id, r]));
  const counts = { block: 0, unblock: 0, refresh: 0, none: 0 };
  const statements = [];

  for (const h of health.results) {
    const b = blockedById.get(h.scraper_id) ?? null;
    const action = decideBlockAction(h, b, now);
    counts[action]++;
    if (action === 'block') {
      statements.push(db.prepare(`INSERT INTO scraper_blocklist ON CONFLICT(scraper_id) DO UPDATE`).bind(h.scraper_id, now.toISOString(), h.last_error, h.consecutive_failures, plusDays(now, BLOCK_TTL_DAYS)));
    } else if (action === 'unblock') {
      statements.push(db.prepare(`DELETE FROM scraper_blocklist WHERE scraper_id = ?1`).bind(h.scraper_id));
    } else if (action === 'refresh') {
      statements.push(db.prepare(`UPDATE scraper_blocklist SET expires_at = ?2 WHERE scraper_id = ?1`).bind(h.scraper_id, plusDays(now, BLOCK_TTL_DAYS), h.consecutive_failures, h.last_error));
    }
  }

  if (statements.length > 0) await db.batch(statements);
  return counts;
}

async function loadBlockedIdsMirror(db, now) {
  const { results } = await db.prepare(`SELECT scraper_id FROM scraper_blocklist WHERE expires_at > ?1`).bind(now.toISOString()).all();
  return new Set((results ?? []).map((r) => r.scraper_id));
}

// ---------------------------------------------------------------------------

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
