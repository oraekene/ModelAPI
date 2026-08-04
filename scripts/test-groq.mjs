/**
 * Groq scraper tests — mirrors src/scrapers/groq.ts.
 *   node scripts/test-groq.mjs
 */

let passed = 0, failed = 0;
const check = (n, c, d = '') => {
  if (c) { passed++; console.log(`  PASS  ${n}`); }
  else { failed++; console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`); }
};

// ---------------------------------------------------------------------------
// Mock D1 database
// ---------------------------------------------------------------------------

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
            // Simulate UPSERT
            if (sql.includes('INSERT')) {
              db._store.set(params[0], params.slice(1));
            }
            return { success: true };
          },
          async first() {
            const key = params[0];
            return db._store.get(key) ?? null;
          },
        };
      },
    };
  }

  async batch(statements) {
    for (const stmt of statements) {
      await stmt.run();
    }
    return { success: true };
  }
}

// ---------------------------------------------------------------------------
// GroqScraper (inlined for testing without ESM build)
// ---------------------------------------------------------------------------

const GROQ_API = 'https://api.groq.com/openai/v1';

class GroqScraper {
  constructor() {
    this.id = 'groq';
    this.category = 'inference';
    this.displayName = 'Groq';
    this._health = {
      scraperId: 'groq',
      lastRunAt: null,
      lastStatus: 'never_run',
      lastError: null,
      consecutiveFailures: 0,
      modelsFound: 0,
      scoresWritten: 0,
    };
  }

  planMessages(runId) {
    return [{ kind: this.id, runId, payload: {} }];
  }

  async handle(msg, env) {
    const startedAt = Date.now();
    try {
      const result = await this.doHandle(msg, env);
      this._health.lastRunAt = new Date().toISOString();
      this._health.lastStatus = 'ok';
      this._health.lastError = null;
      this._health.consecutiveFailures = 0;
      this._health.modelsFound += result.offerings;
      this._health.scoresWritten += result.scores;
      await this.updateHealth(env.DB);
      return result;
    } catch (err) {
      const elapsed = Date.now() - startedAt;
      this._health.lastRunAt = new Date().toISOString();
      this._health.lastStatus = elapsed > 30_000 ? 'timeout' : 'error';
      this._health.lastError = err instanceof Error ? err.message : String(err);
      this._health.consecutiveFailures += 1;
      await this.updateHealth(env.DB);
      throw err;
    }
  }

  health() {
    return { ...this._health };
  }

  async doHandle(_msg, env) {
    const apiKey = env.GROQ_API_KEY;
    if (!apiKey) {
      throw new Error('GROQ_API_KEY not set');
    }

    // Fetch model catalog
    const res = await fetch(`${GROQ_API}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      throw new Error(`groq /models: HTTP ${res.status}`);
    }
    const catalog = await res.json();
    const models = (catalog.data ?? []).filter((m) => m.active);

    // Normalize into offerings
    const now = new Date().toISOString();
    const stmt = env.DB.prepare(
      `INSERT INTO offerings (
         model_id, harness_id, plan_id, medium, context_window,
         supports_vision, supports_tools, is_free,
         price_prompt, price_completion, access_url, last_verified_at, score_key
       ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)
       ON CONFLICT(model_id, harness_id, plan_id) DO UPDATE SET
         context_window   = excluded.context_window,
         supports_vision  = excluded.supports_vision,
         supports_tools   = excluded.supports_tools,
         is_free          = excluded.is_free,
         price_prompt     = excluded.price_prompt,
         price_completion = excluded.price_completion,
         last_verified_at = excluded.last_verified_at,
         score_key        = excluded.score_key`,
    );

    const rows = models.map((m) => {
      const id = `groq/${m.id}`;
      return stmt.bind(
        id,
        'groq-api',
        'free',
        'api',
        m.context_window ?? null,
        m.supports_vision ? 1 : 0,
        m.supports_tools ? 1 : 0,
        1,
        0,
        0,
        `https://console.groq.com/docs/${m.id}`,
        now,
        m.id,
      );
    });

    if (rows.length > 0) {
      await env.DB.batch(rows);
    }

    // Write quota pool for free tier
    await env.DB.prepare(
      `INSERT INTO quota_pools (pool_id, platform, label, quota_unit, quota_value, confidence, last_verified_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(pool_id) DO UPDATE SET
         quota_value = excluded.quota_value,
         last_verified_at = excluded.last_verified_at`,
    ).bind(
      'groq-free',
      'groq',
      'Groq Free Tier',
      'requests/day',
      14_400,
      'documented',
      now,
    ).run();

    return {
      offerings: rows.length,
      scores: 0,
      quotas: 1,
      note: `${rows.length} models from Groq API`,
    };
  }

  async updateHealth(db) {
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
      this._health.scraperId,
      this._health.lastRunAt,
      this._health.lastStatus,
      this._health.lastError,
      this._health.consecutiveFailures,
      this._health.modelsFound,
      this._health.scoresWritten,
    ).run();
  }
}

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

function mockFetch(catalog) {
  return async (url, opts) => {
    if (url.includes('/models')) {
      return {
        ok: true,
        json: async () => catalog,
      };
    }
    return { ok: false, status: 404 };
  };
}

function mockFetchError(status = 500) {
  return async () => ({
    ok: false,
    status,
    json: async () => ({ error: 'server error' }),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log('GroqScraper — planMessages');

{
  const scraper = new GroqScraper();
  const msgs = scraper.planMessages('run-1');
  check('planMessages returns one message', msgs.length === 1);
  check('message kind is groq', msgs[0].kind === 'groq');
  check('message runId is set', msgs[0].runId === 'run-1');
}

console.log('');
console.log('GroqScraper — doHandle with models');

{
  const scraper = new GroqScraper();
  const db = new MockDB();
  const catalog = {
    object: 'list',
    data: [
      {
        id: 'llama-3.3-70b-versatile',
        object: 'model',
        created: 1234567890,
        owned_by: 'meta',
        active: true,
        context_window: 131072,
        supports_tools: true,
        supports_vision: false,
      },
      {
        id: 'mixtral-8x7b-32768',
        object: 'model',
        created: 1234567890,
        owned_by: 'mistral',
        active: true,
        context_window: 32768,
        supports_tools: false,
        supports_vision: false,
      },
      {
        id: 'gemma2-9b-it',
        object: 'model',
        created: 1234567890,
        owned_by: 'google',
        active: false, // inactive model should be filtered out
        context_window: 8192,
      },
    ],
  };

  // Override global fetch for this test
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch(catalog);

  const result = await scraper.handle(
    { kind: 'groq', runId: 'r1', payload: {} },
    { DB: db, CACHE: {}, GROQ_API_KEY: 'test-key' },
  );

  globalThis.fetch = originalFetch;

  check('handle returns correct offering count', result.offerings === 2);
  check('handle returns 0 scores', result.scores === 0);
  check('handle returns 1 quota', result.quotas === 1);
  check('inactive models are filtered', result.offerings === 2);
  check('health status is ok', scraper.health().lastStatus === 'ok');
  check('health modelsFound is 2', scraper.health().modelsFound === 2);
}

console.log('');
console.log('GroqScraper — offering normalization');

{
  const scraper = new GroqScraper();
  const db = new MockDB();
  const catalog = {
    object: 'list',
    data: [
      {
        id: 'llama-3.3-70b-versatile',
        object: 'model',
        created: 1234567890,
        owned_by: 'meta',
        active: true,
        context_window: 131072,
        supports_tools: true,
        supports_vision: true,
      },
    ],
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch(catalog);

  await scraper.handle(
    { kind: 'groq', runId: 'r1', payload: {} },
    { DB: db, CACHE: {}, GROQ_API_KEY: 'test-key' },
  );

  globalThis.fetch = originalFetch;

  const offeringWrite = db._writes.find((w) => w.sql.includes('INSERT INTO offerings'));
  check('offering has correct model_id', offeringWrite.params[0] === 'groq/llama-3.3-70b-versatile');
  check('offering has correct harness_id', offeringWrite.params[1] === 'groq-api');
  check('offering has correct plan_id', offeringWrite.params[2] === 'free');
  check('offering has correct medium', offeringWrite.params[3] === 'api');
  check('offering has correct context_window', offeringWrite.params[4] === 131072);
  check('offering has supports_vision=1', offeringWrite.params[5] === 1);
  check('offering has supports_tools=1', offeringWrite.params[6] === 1);
  check('offering has is_free=1', offeringWrite.params[7] === 1);
  check('offering has price_prompt=0', offeringWrite.params[8] === 0);
  check('offering has price_completion=0', offeringWrite.params[9] === 0);
  check('offering has correct score_key', offeringWrite.params[12] === 'llama-3.3-70b-versatile');
}

console.log('');
console.log('GroqScraper — quota pool');

{
  const scraper = new GroqScraper();
  const db = new MockDB();
  const catalog = { object: 'list', data: [] };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch(catalog);

  await scraper.handle(
    { kind: 'groq', runId: 'r1', payload: {} },
    { DB: db, CACHE: {}, GROQ_API_KEY: 'test-key' },
  );

  globalThis.fetch = originalFetch;

  const quotaWrite = db._writes.find((w) => w.sql.includes('INSERT INTO quota_pools'));
  check('quota pool has correct pool_id', quotaWrite.params[0] === 'groq-free');
  check('quota pool has correct platform', quotaWrite.params[1] === 'groq');
  check('quota pool has correct label', quotaWrite.params[2] === 'Groq Free Tier');
  check('quota pool has correct unit', quotaWrite.params[3] === 'requests/day');
  check('quota pool has correct value', quotaWrite.params[4] === 14_400);
  check('quota pool has correct confidence', quotaWrite.params[5] === 'documented');
}

console.log('');
console.log('GroqScraper — health tracking');

{
  const scraper = new GroqScraper();
  const db = new MockDB();
  const catalog = { object: 'list', data: [{ id: 'm1', active: true }] };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch(catalog);

  // First run
  await scraper.handle(
    { kind: 'groq', runId: 'r1', payload: {} },
    { DB: db, CACHE: {}, GROQ_API_KEY: 'test-key' },
  );
  check('health after first run is ok', scraper.health().lastStatus === 'ok');
  check('health modelsFound is 1', scraper.health().modelsFound === 1);
  check('health consecutiveFailures is 0', scraper.health().consecutiveFailures === 0);

  // Second run
  await scraper.handle(
    { kind: 'groq', runId: 'r2', payload: {} },
    { DB: db, CACHE: {}, GROQ_API_KEY: 'test-key' },
  );
  check('health accumulates models', scraper.health().modelsFound === 2);
  check('health writes to D1', db._writes.filter((w) => w.sql.includes('scraper_health')).length === 2);

  globalThis.fetch = originalFetch;
}

console.log('');
console.log('GroqScraper — error handling');

{
  const scraper = new GroqScraper();
  const db = new MockDB();

  // Missing API key
  try {
    await scraper.handle(
      { kind: 'groq', runId: 'r1', payload: {} },
      { DB: db, CACHE: {} },
    );
    check('throws for missing API key', false, 'did not throw');
  } catch (e) {
    check('throws for missing API key', e.message === 'GROQ_API_KEY not set');
    check('health status is error after missing key', scraper.health().lastStatus === 'error');
    check('health consecutiveFailures is 1', scraper.health().consecutiveFailures === 1);
  }

  // API error
  const scraper2 = new GroqScraper();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchError(429);

  try {
    await scraper2.handle(
      { kind: 'groq', runId: 'r2', payload: {} },
      { DB: db, CACHE: {}, GROQ_API_KEY: 'test-key' },
    );
    check('throws for API error', false, 'did not throw');
  } catch (e) {
    check('throws for API error', e.message === 'groq /models: HTTP 429');
    check('health status is error after API error', scraper2.health().lastStatus === 'error');
    check('health lastError is set', scraper2.health().lastError === 'groq /models: HTTP 429');
  }

  globalThis.fetch = originalFetch;
}

console.log('');
console.log('GroqScraper — empty catalog');

{
  const scraper = new GroqScraper();
  const db = new MockDB();
  const catalog = { object: 'list', data: [] };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch(catalog);

  const result = await scraper.handle(
    { kind: 'groq', runId: 'r1', payload: {} },
    { DB: db, CACHE: {}, GROQ_API_KEY: 'test-key' },
  );

  globalThis.fetch = originalFetch;

  check('empty catalog returns 0 offerings', result.offerings === 0);
  check('empty catalog still writes quota', result.quotas === 1);
  check('health status is ok', scraper.health().lastStatus === 'ok');
}

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
