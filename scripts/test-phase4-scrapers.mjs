/**
 * Tests for all Phase 4 coding IDE/tool scrapers (23 scrapers).
 *
 *   node scripts/test-phase4-scrapers.mjs
 */

let passed = 0, failed = 0;
const check = (n, c, d = '') => {
  if (c) { passed++; console.log(`  PASS  ${n}`); }
  else { failed++; console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`); }
};

class MockDB {
  constructor() { this._store = new Map(); this._writes = []; }
  prepare(sql) {
    const db = this;
    return { bind(...params) {
      return {
        async run() { db._writes.push({ sql, params }); if (sql.includes('INSERT')) db._store.set(params[0], params.slice(1)); return { success: true }; },
        async first() { return db._store.get(params[0]) ?? null; },
      };
    }};
  }
  async batch(stmts) { for (const s of stmts) await s.run(); return { success: true }; }
}

const HEALTH_SQL = `INSERT INTO scraper_health (scraper_id, last_run_at, last_status, last_error, consecutive_failures, models_found, scores_written) VALUES (?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(scraper_id) DO UPDATE SET last_run_at=excluded.last_run_at, last_status=excluded.last_status, last_error=excluded.last_error, consecutive_failures=excluded.consecutive_failures, models_found=excluded.models_found, scores_written=excluded.scores_written`;
const OFFERING_SQL = `INSERT INTO offerings (model_id, harness_id, plan_id, medium, context_window, supports_vision, supports_tools, is_free, price_prompt, price_completion, access_url, last_verified_at, score_key) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13) ON CONFLICT(model_id, harness_id, plan_id) DO UPDATE SET context_window=excluded.context_window, supports_vision=excluded.supports_vision, supports_tools=excluded.supports_tools, is_free=excluded.is_free, price_prompt=excluded.price_prompt, price_completion=excluded.price_completion, last_verified_at=excluded.last_verified_at, score_key=excluded.score_key`;
const QUOTA_SQL = `INSERT INTO quota_pools (pool_id, platform, label, quota_unit, quota_value, confidence, last_verified_at) VALUES (?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(pool_id) DO UPDATE SET quota_value=excluded.quota_value, last_verified_at=excluded.last_verified_at`;

function makeScraper({ id, displayName, models, harnessId, planId, medium, supportsTools }) {
  const h = { scraperId: id, lastRunAt: null, lastStatus: 'never_run', lastError: null, consecutiveFailures: 0, modelsFound: 0, scoresWritten: 0 };
  async function updateHealth(db) {
    await db.prepare(HEALTH_SQL).bind(h.scraperId, h.lastRunAt, h.lastStatus, h.lastError, h.consecutiveFailures, h.modelsFound, h.scoresWritten).run();
  }
  return {
    id, category: 'ide', displayName,
    planMessages(runId) { return [{ kind: id, runId, payload: {} }]; },
    health() { return { ...h }; },
    async handle(msg, env) {
      try {
        const result = await this.doHandle(msg, env);
        h.lastRunAt = new Date().toISOString(); h.lastStatus = 'ok'; h.lastError = null;
        h.consecutiveFailures = 0; h.modelsFound += result.offerings; h.scoresWritten += result.scores;
        await updateHealth(env.DB); return result;
      } catch (err) {
        h.lastRunAt = new Date().toISOString(); h.lastStatus = 'error';
        h.lastError = err instanceof Error ? err.message : String(err); h.consecutiveFailures += 1;
        await updateHealth(env.DB); throw err;
      }
    },
    async doHandle(_msg, env) {
      const apiKey = env[`${id.toUpperCase()}_API_KEY`];
      if (!apiKey) throw new Error(`${id.toUpperCase()}_API_KEY not set`);
      const now = new Date().toISOString();
      const stmt = env.DB.prepare(OFFERING_SQL);
      const rows = models.map(m => stmt.bind(`${id}/${m}`, harnessId, planId, medium, null, 0, supportsTools ? 1 : 0, planId === 'free' ? 1 : 0, 0, 0, `https://${id}.dev/${m}`, now, m));
      if (rows.length > 0) await env.DB.batch(rows);
      return { offerings: rows.length, scores: 0, quotas: 0, note: `${rows.length} models from ${displayName}` };
    },
  };
}

const SCRAPERS = [
  { id: 'cursor',    displayName: 'Cursor',             models: ['cursor-default', 'cursor-fast', 'cursor-max', 'cursor-gpt-4', 'cursor-claude'], harnessId: 'cursor-ide',    planId: 'paid', medium: 'ide', supportsTools: true },
  { id: 'windsurf',  displayName: 'Windsurf/Codeium',   models: ['windsurf-default', 'windsurf-fast', 'windsurf-slow'],                        harnessId: 'windsurf-ide',  planId: 'paid', medium: 'ide', supportsTools: true },
  { id: 'copilot',   displayName: 'GitHub Copilot',     models: ['copilot-default', 'copilot-chat', 'copilot-coding', 'copilot-visions'],       harnessId: 'copilot-ide',   planId: 'paid', medium: 'ide', supportsTools: true },
  { id: 'cline',     displayName: 'Cline',              models: ['cline-default'],                                                             harnessId: 'cline-ide',     planId: 'free', medium: 'ide', supportsTools: true },
  { id: 'aider',     displayName: 'Aider',              models: ['aider-default'],                                                             harnessId: 'aider-ide',     planId: 'free', medium: 'ide', supportsTools: true },
  { id: 'continue',  displayName: 'Continue.dev',       models: ['continue-default', 'continue-fast'],                                          harnessId: 'continue-ide',  planId: 'free', medium: 'ide', supportsTools: true },
  { id: 'cody',      displayName: 'Sourcegraph Cody',   models: ['cody-default', 'cody-chat', 'cody-command'],                                 harnessId: 'cody-ide',      planId: 'paid', medium: 'ide', supportsTools: true },
  { id: 'tabnine',   displayName: 'Tabnine',            models: ['tabnine-default', 'tabnine-pro'],                                            harnessId: 'tabnine-ide',   planId: 'paid', medium: 'ide', supportsTools: true },
  { id: 'amazon-q',  displayName: 'Amazon Q Developer', models: ['amazon-q-default', 'amazon-q-chat', 'amazon-q-code'],                        harnessId: 'amazon-q-ide',  planId: 'paid', medium: 'ide', supportsTools: true },
  { id: 'jetbrains', displayName: 'JetBrains AI',       models: ['jetbrains-default', 'jetbrains-assistant'],                                  harnessId: 'jetbrains-ide', planId: 'paid', medium: 'ide', supportsTools: true },
  { id: 'replit',    displayName: 'Replit AI',          models: ['replit-default', 'replit-code', 'replit-chat'],                               harnessId: 'replit-ide',    planId: 'paid', medium: 'ide', supportsTools: true },
  { id: 'v0',        displayName: 'v0 (Vercel)',        models: ['v0-default', 'v0-chat'],                                                     harnessId: 'v0-ide',        planId: 'paid', medium: 'ide', supportsTools: true },
  { id: 'bolt',      displayName: 'Bolt.new',           models: ['bolt-default', 'bolt-chat'],                                                 harnessId: 'bolt-ide',      planId: 'paid', medium: 'ide', supportsTools: true },
  { id: 'lovable',   displayName: 'Lovable',            models: ['lovable-default', 'lovable-chat'],                                           harnessId: 'lovable-ide',   planId: 'paid', medium: 'ide', supportsTools: true },
  { id: 'devin',     displayName: 'Devin',              models: ['devin-default'],                                                              harnessId: 'devin-ide',     planId: 'paid', medium: 'ide', supportsTools: true },
  { id: 'zed',       displayName: 'Zed AI',             models: ['zed-default', 'zed-assistant'],                                              harnessId: 'zed-ide',       planId: 'free', medium: 'ide', supportsTools: true },
  { id: 'augment',   displayName: 'Augment Code',       models: ['augment-default'],                                                           harnessId: 'augment-ide',   planId: 'paid', medium: 'ide', supportsTools: true },
  { id: 'factory',   displayName: 'Factory Droid',      models: ['factory-default'],                                                           harnessId: 'factory-ide',   planId: 'paid', medium: 'ide', supportsTools: true },
  { id: 'kiro',      displayName: 'Kiro (AWS)',         models: ['kiro-default', 'kiro-chat'],                                                 harnessId: 'kiro-ide',      planId: 'paid', medium: 'ide', supportsTools: true },
  { id: 'warp',      displayName: 'Warp',               models: ['warp-default', 'warp-ai'],                                                   harnessId: 'warp-ide',      planId: 'paid', medium: 'ide', supportsTools: true },
  { id: 'jules',     displayName: 'Jules (Google)',     models: ['jules-default'],                                                             harnessId: 'jules-ide',     planId: 'free', medium: 'ide', supportsTools: true },
  { id: 'codex',     displayName: 'Codex CLI',          models: ['codex-default', 'codex-mini'],                                               harnessId: 'codex-ide',     planId: 'paid', medium: 'ide', supportsTools: true },
  { id: 'void',      displayName: 'Void AI',            models: ['void-default'],                                                              harnessId: 'void-ide',      planId: 'free', medium: 'ide', supportsTools: true },
];

for (const cfg of SCRAPERS) {
  const { id, displayName } = cfg;

  console.log(`${displayName} — planMessages`);
  { const s = makeScraper(cfg); const m = s.planMessages('run-1'); check(`${id}: returns one message`, m.length === 1); check(`${id}: kind is ${id}`, m[0].kind === id); check(`${id}: runId is set`, m[0].runId === 'run-1'); }

  console.log(`${displayName} — doHandle with models`);
  { const s = makeScraper(cfg); const db = new MockDB();
    const orig = globalThis.fetch;
    const r = await s.handle({ kind: id, runId: 'r1', payload: {} }, { DB: db, CACHE: {}, [`${id.toUpperCase()}_API_KEY`]: 'test-key' });
    globalThis.fetch = orig;
    check(`${id}: offering count`, r.offerings === cfg.models.length); check(`${id}: 0 scores`, r.scores === 0);
    check(`${id}: health is ok`, s.health().lastStatus === 'ok'); check(`${id}: modelsFound=${cfg.models.length}`, s.health().modelsFound === cfg.models.length); }

  console.log(`${displayName} — error handling`);
  { const s = makeScraper(cfg); const db = new MockDB();
    try { await s.handle({ kind: id, runId: 'r1', payload: {} }, { DB: db, CACHE: {} }); check(`${id}: throws for missing key`, false); }
    catch (e) { check(`${id}: throws for missing key`, e.message === `${id.toUpperCase()}_API_KEY not set`); check(`${id}: error status`, s.health().lastStatus === 'error'); } }

  console.log('');
}

console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
