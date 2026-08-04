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

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
