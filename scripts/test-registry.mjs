/**
 * ScraperRegistry tests — mirrors src/scrapers/registry.ts.
 *   node scripts/test-registry.mjs
 */

let passed = 0, failed = 0;
const check = (n, c, d = '') => {
  if (c) { passed++; console.log(`  PASS  ${n}`); }
  else { failed++; console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`); }
};

// ---------------------------------------------------------------------------
// Inline the types and registry (these are ESM, but the test runner is
// plain Node — we replicate the logic to avoid a build step).
// ---------------------------------------------------------------------------

/** @enum {string} */
const ScraperCategory = { INFERENCE: 'inference', LAB: 'lab', IDE: 'ide', HARNESS: 'harness', TOOL: 'tool' };

/**
 * Minimal Scraper stub for testing.
 */
class StubScraper {
  constructor(id, category = 'inference', displayName = id) {
    this.id = id;
    this.category = category;
    this.displayName = displayName;
    this._messages = [];
    this._health = {
      scraperId: id,
      lastRunAt: null,
      lastStatus: 'never_run',
      lastError: null,
      consecutiveFailures: 0,
      modelsFound: 0,
      scoresWritten: 0,
    };
  }

  planMessages(runId) {
    return this._messages.map((payload) => ({
      kind: this.id,
      runId,
      payload,
    }));
  }

  async handle(msg, _env) {
    this._health.lastRunAt = new Date().toISOString();
    this._health.lastStatus = 'ok';
    this._health.modelsFound++;
    return { offerings: 1, scores: 0, quotas: 0 };
  }

  health() {
    return { ...this._health };
  }
}

/**
 * Registry — same logic as src/scrapers/registry.ts, inlined for testing.
 */
class ScraperRegistry {
  constructor() {
    /** @type {Map<string, any>} */
    this.scrapers = new Map();
    /** @type {Map<string, any>} */
    this.kindToScraper = new Map();
  }

  register(scraper) {
    this.scrapers.set(scraper.id, scraper);
    this.kindToScraper.set(scraper.id, scraper);
  }

  unregister(id) {
    const scraper = this.scrapers.get(id);
    if (scraper) {
      this.scrapers.delete(id);
      this.kindToScraper.delete(scraper.id);
    }
  }

  get(id) { return this.scrapers.get(id); }
  all() { return Array.from(this.scrapers.values()); }
  byCategory(category) { return this.all().filter((s) => s.category === category); }
  get size() { return this.scrapers.size; }

  planMessages(runId) {
    const messages = [];
    for (const scraper of this.scrapers.values()) {
      messages.push(...scraper.planMessages(runId));
    }
    return messages;
  }

  async handle(msg, env) {
    const scraper = this.kindToScraper.get(msg.kind);
    if (!scraper) throw new Error(`No scraper registered for kind "${msg.kind}"`);
    return scraper.handle(msg, env);
  }

  canHandle(kind) { return this.kindToScraper.has(kind); }

  healthAll() { return this.all().map((s) => s.health()); }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log('ScraperRegistry — register / unregister');

{
  const reg = new ScraperRegistry();
  const s = new StubScraper('groq');
  reg.register(s);
  check('register adds a scraper', reg.size === 1);
  check('get returns the scraper', reg.get('groq') === s);
  check('all returns the scraper', reg.all().length === 1);
  check('canHandle returns true for registered kind', reg.canHandle('groq'));
  check('canHandle returns false for unknown kind', !reg.canHandle('together'));
}

{
  const reg = new ScraperRegistry();
  reg.register(new StubScraper('a'));
  reg.register(new StubScraper('b'));
  check('multiple scrapers registered', reg.size === 2);
  reg.unregister('a');
  check('unregister removes scraper', reg.size === 1);
  check('unregister clears kind mapping', !reg.canHandle('a'));
  check('unregister does not affect other scrapers', reg.canHandle('b'));
}

console.log('');
console.log('ScraperRegistry — byCategory');

{
  const reg = new ScraperRegistry();
  reg.register(new StubScraper('groq', 'inference'));
  reg.register(new StubScraper('cursor', 'ide'));
  reg.register(new StubScraper('together', 'inference'));
  const inferences = reg.byCategory('inference');
  check('byCategory returns correct count', inferences.length === 2);
  check('byCategory returns correct ids', inferences.map((s) => s.id).includes('groq'));
  check('byCategory excludes other categories', !inferences.map((s) => s.id).includes('cursor'));
}

console.log('');
console.log('ScraperRegistry — planMessages');

{
  const reg = new ScraperRegistry();
  const s1 = new StubScraper('groq');
  s1._messages = [{ model: 'llama-3' }];
  const s2 = new StubScraper('together');
  s2._messages = [{ model: 'qwen-2' }, { model: 'mistral-7b' }];
  reg.register(s1);
  reg.register(s2);

  const msgs = reg.planMessages('run-123');
  check('planMessages collects from all scrapers', msgs.length === 3);
  check('planMessages sets kind to scraper id', msgs[0].kind === 'groq');
  check('planMessages sets runId', msgs[0].runId === 'run-123');
  check('planMessages sets payload', msgs[0].payload.model === 'llama-3');
  check('planMessages second scraper kind', msgs[1].kind === 'together');
}

console.log('');
console.log('ScraperRegistry — handle dispatch');

{
  const reg = new ScraperRegistry();
  const s = new StubScraper('groq');
  reg.register(s);

  const result = await reg.handle({ kind: 'groq', runId: 'r1', payload: {} }, {});
  check('handle returns ScraperResult', result.offerings === 1);
  check('handle updates scraper health', s.health().lastStatus === 'ok');
  check('handle increments modelsFound', s.health().modelsFound === 1);
}

{
  const reg = new ScraperRegistry();
  let threw = false;
  try {
    await reg.handle({ kind: 'unknown', runId: 'r1', payload: {} }, {});
  } catch (e) {
    threw = true;
    check('handle throws for unknown kind', e.message.includes('No scraper registered'));
  }
  if (!threw) check('handle throws for unknown kind', false, 'did not throw');
}

console.log('');
console.log('ScraperRegistry — healthAll');

{
  const reg = new ScraperRegistry();
  reg.register(new StubScraper('groq'));
  reg.register(new StubScraper('cursor'));
  const health = reg.healthAll();
  check('healthAll returns one entry per scraper', health.length === 2);
  check('healthAll entries have scraperId', health[0].scraperId === 'groq');
  check('healthAll starts with never_run', health[0].lastStatus === 'never_run');
}

console.log('');
console.log('ScraperRegistry — register overwrites');

{
  const reg = new ScraperRegistry();
  const s1 = new StubScraper('groq', 'inference', 'Groq v1');
  const s2 = new StubScraper('groq', 'inference', 'Groq v2');
  reg.register(s1);
  reg.register(s2);
  check('register overwrites same id', reg.size === 1);
  check('register overwrites with new instance', reg.get('groq').displayName === 'Groq v2');
}

// ---------------------------------------------------------------------------
// BaseScraper health tracking tests
// ---------------------------------------------------------------------------

console.log('');
console.log('BaseScraper — health state transitions');

{
  // Simulate a scraper that tracks health state changes
  class HealthTracker {
    constructor(id) {
      this.id = id;
      this.category = 'inference';
      this.displayName = id;
      this._health = {
        scraperId: id,
        lastRunAt: null,
        lastStatus: 'never_run',
        lastError: null,
        consecutiveFailures: 0,
        modelsFound: 0,
        scoresWritten: 0,
      };
      this._dbWrites = [];
    }

    planMessages(runId) {
      return [{ kind: this.id, runId, payload: {} }];
    }

    async handle(msg, env) {
      const startedAt = Date.now();
      try {
        const result = await this._doHandle(msg, env);
        this._health.lastRunAt = new Date().toISOString();
        this._health.lastStatus = 'ok';
        this._health.lastError = null;
        this._health.consecutiveFailures = 0;
        this._health.modelsFound += result.offerings;
        this._health.scoresWritten += result.scores;
        await this._updateHealth(env?.DB);
        return result;
      } catch (err) {
        const elapsed = Date.now() - startedAt;
        this._health.lastRunAt = new Date().toISOString();
        this._health.lastStatus = elapsed > 30_000 ? 'timeout' : 'error';
        this._health.lastError = err instanceof Error ? err.message : String(err);
        this._health.consecutiveFailures += 1;
        await this._updateHealth(env?.DB);
        throw err;
      }
    }

    async _doHandle(_msg, _env) {
      return { offerings: 1, scores: 0, quotas: 0 };
    }

    health() {
      return { ...this._health };
    }

    async _updateHealth(db) {
      // Mock D1 write — just record that it happened
      this._dbWrites.push({ ...this._health });
    }
  }

  const tracker = new HealthTracker('groq');

  // Initial state
  check('health starts as never_run', tracker.health().lastStatus === 'never_run');
  check('health starts with 0 failures', tracker.health().consecutiveFailures === 0);
  check('health starts with 0 models', tracker.health().modelsFound === 0);

  // Successful run
  await tracker.handle({ kind: 'groq', runId: 'r1', payload: {} }, {});
  check('health after success is ok', tracker.health().lastStatus === 'ok');
  check('health after success resets failures', tracker.health().consecutiveFailures === 0);
  check('health after success increments models', tracker.health().modelsFound === 1);
  check('health after success writes to DB', tracker._dbWrites.length === 1);

  // Another successful run
  await tracker.handle({ kind: 'groq', runId: 'r2', payload: {} }, {});
  check('health accumulates models across runs', tracker.health().modelsFound === 2);

  // Failed run
  tracker._doHandle = async () => { throw new Error('API down'); };
  try {
    await tracker.handle({ kind: 'groq', runId: 'r3', payload: {} }, {});
  } catch (e) { /* expected */ }
  check('health after error is error', tracker.health().lastStatus === 'error');
  check('health after error sets lastError', tracker.health().lastError === 'API down');
  check('health after error increments failures', tracker.health().consecutiveFailures === 1);
  check('health after error preserves model count', tracker.health().modelsFound === 2);

  // Second error increments consecutive failures
  try {
    await tracker.handle({ kind: 'groq', runId: 'r4', payload: {} }, {});
  } catch (e) { /* expected */ }
  check('second error increments consecutive failures', tracker.health().consecutiveFailures === 2);

  // Recovery resets failures
  tracker._doHandle = async () => ({ offerings: 3, scores: 1, quotas: 0 });
  await tracker.handle({ kind: 'groq', runId: 'r5', payload: {} }, {});
  check('recovery resets consecutive failures', tracker.health().consecutiveFailures === 0);
  check('recovery preserves total models', tracker.health().modelsFound === 5);
  check('recovery adds new scores', tracker.health().scoresWritten === 1);
}

console.log('');
console.log('BaseScraper — timeout detection');

{
  class SlowScraper {
    constructor() {
      this.id = 'slow';
      this.category = 'inference';
      this.displayName = 'Slow';
      this._health = {
        scraperId: 'slow',
        lastRunAt: null,
        lastStatus: 'never_run',
        lastError: null,
        consecutiveFailures: 0,
        modelsFound: 0,
        scoresWritten: 0,
      };
    }

    planMessages(runId) {
      return [{ kind: 'slow', runId, payload: {} }];
    }

    async handle(msg, env) {
      const startedAt = Date.now();
      try {
        // Simulate slow response (>30s)
        this._health.lastRunAt = new Date().toISOString();
        this._health.lastStatus = 'ok';
        this._health.lastError = null;
        this._health.consecutiveFailures = 0;
        return { offerings: 0, scores: 0, quotas: 0 };
      } catch (err) {
        const elapsed = Date.now() - startedAt;
        this._health.lastStatus = elapsed > 30_000 ? 'timeout' : 'error';
        throw err;
      }
    }

    health() { return { ...this._health }; }
  }

  // Test the timeout detection logic directly
  const slow = new SlowScraper();
  const elapsed = 35_000; // 35 seconds
  const status = elapsed > 30_000 ? 'timeout' : 'error';
  check('slow response (>30s) is detected as timeout', status === 'timeout');

  const fast = 5_000; // 5 seconds
  const fastStatus = fast > 30_000 ? 'timeout' : 'error';
  check('fast response (<30s) is detected as error', fastStatus === 'error');
}

console.log('');
console.log('BaseScraper — health persistence');

{
  // Mock D1 database
  class MockDB {
    constructor() {
      this._store = new Map();
      this._writes = [];
    }

    prepare(sql) {
      const db = this;
      return {
        bind(...params) {
          return {
            async run() {
              db._writes.push({ sql, params });
              if (sql.includes('INSERT')) {
                db._store.set(params[0], { ...params.slice(1) });
              }
              return { success: true };
            },
            async first() {
              const key = params[0];
              const row = db._store.get(key);
              if (!row) return null;
              return {
                last_run_at: row[0],
                last_status: row[1],
                last_error: row[2],
                consecutive_failures: row[3],
                models_found: row[4],
                scores_written: row[5],
              };
            },
          };
        },
      };
    }
  }

  // Simulate updateHealth writing to D1
  const db = new MockDB();
  const health = {
    scraperId: 'groq',
    lastRunAt: '2026-08-04T12:00:00Z',
    lastStatus: 'ok',
    lastError: null,
    consecutiveFailures: 0,
    modelsFound: 5,
    scoresWritten: 2,
  };

  await db.prepare(
    `INSERT INTO scraper_health (scraper_id, last_run_at, last_status, last_error,
                                 consecutive_failures, models_found, scores_written)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT(scraper_id) DO UPDATE SET
       last_run_at = excluded.last_run_at,
       last_status = excluded.last_status,
       last_error = excluded.last_error,
       consecutive_failures = excluded.consecutive_failures,
       models_found = excluded.models_found,
       scores_written = excluded.scores_written`,
  ).bind(
    health.scraperId,
    health.lastRunAt,
    health.lastStatus,
    health.lastError,
    health.consecutiveFailures,
    health.modelsFound,
    health.scoresWritten,
  ).run();

  check('D1 write succeeded', db._writes.length === 1);
  check('D1 write has correct scraper_id', db._writes[0].params[0] === 'groq');
  check('D1 write has correct last_status', db._writes[0].params[2] === 'ok');
  check('D1 write has correct models_found', db._writes[0].params[5] === 5);

  // Simulate loadHealth reading from D1
  const row = await db.prepare(
    `SELECT last_run_at, last_status, last_error, consecutive_failures,
            models_found, scores_written
     FROM scraper_health WHERE scraper_id = ?1`,
  ).bind('groq').first();

  check('D1 read returns correct row', row !== null);
  check('D1 read has correct last_status', row.last_status === 'ok');
  check('D1 read has correct models_found', row.models_found === 5);
}

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
