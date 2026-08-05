/**
 * Tests for all Phase 5 agent harness scrapers (11 scrapers).
 *
 *   node scripts/test-phase5-scrapers.mjs
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

function makeScraper({ id, displayName, models, harnessId, planId, medium }) {
  const h = { scraperId: id, lastRunAt: null, lastStatus: 'never_run', lastError: null, consecutiveFailures: 0, modelsFound: 0, scoresWritten: 0 };
  async function updateHealth(db) {
    await db.prepare(HEALTH_SQL).bind(h.scraperId, h.lastRunAt, h.lastStatus, h.lastError, h.consecutiveFailures, h.modelsFound, h.scoresWritten).run();
  }
  return {
    id, category: 'agent', displayName,
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
      const envKey = id.replace(/-/g, '_').toUpperCase() + '_API_KEY';
      const apiKey = env[envKey];
      if (!apiKey) throw new Error(`${envKey} not set`);
      const now = new Date().toISOString();
      const stmt = env.DB.prepare(OFFERING_SQL);
      const rows = models.map(m => stmt.bind(`${id}/${m}`, harnessId, planId, medium, null, 0, 1, planId === 'free' ? 1 : 0, 0, 0, `https://${id}.dev/${m}`, now, m));
      if (rows.length > 0) await env.DB.batch(rows);
      return { offerings: rows.length, scores: 0, quotas: 0, note: `${rows.length} models from ${displayName}` };
    },
  };
}

const SCRAPERS = [
  { id: 'openclaw',     displayName: 'OpenClaw',            models: ['openclaw-default', 'openclaw-chat'],                harnessId: 'openclaw-agent',       planId: 'free', medium: 'agent' },
  { id: 'opencode',     displayName: 'OpenCode',            models: ['opencode-default', 'opencode-chat'],               harnessId: 'opencode-agent',       planId: 'free', medium: 'agent' },
  { id: 'hermes',       displayName: 'Hermes Agent',        models: ['hermes-default', 'hermes-chat'],                   harnessId: 'hermes-agent',         planId: 'free', medium: 'agent' },
  { id: 'amp',          displayName: 'Amp (Sourcegraph)',    models: ['amp-default', 'amp-chat'],                         harnessId: 'amp-agent',            planId: 'paid', medium: 'agent' },
  { id: 'goose',        displayName: 'Goose (Block)',        models: ['goose-default'],                                   harnessId: 'goose-agent',          planId: 'free', medium: 'agent' },
  { id: 'crush',        displayName: 'Crush (Charmbracelet)',models: ['crush-default'],                                   harnessId: 'crush-agent',          planId: 'free', medium: 'agent' },
  { id: 'codex-agent',  displayName: 'Codex (OpenAI) Agent', models: ['codex-agent-default', 'codex-agent-mini'],         harnessId: 'codex-agent-harness',  planId: 'paid', medium: 'agent' },
  { id: 'nemoclaw',     displayName: 'NemoClaw (NVIDIA)',    models: ['nemoclaw-default'],                                harnessId: 'nemoclaw-agent',       planId: 'free', medium: 'agent' },
  { id: 'cursor-agent', displayName: 'Cursor Agent',         models: ['cursor-agent-default', 'cursor-agent-max'],        harnessId: 'cursor-agent-harness', planId: 'paid', medium: 'agent' },
  { id: 'gemini-cli',   displayName: 'Gemini CLI',           models: ['gemini-cli-default', 'gemini-cli-chat'],           harnessId: 'gemini-cli-agent',     planId: 'free', medium: 'agent' },
  { id: 'grok-build',   displayName: 'Grok Build',           models: ['grok-build-default', 'grok-build-chat'],           harnessId: 'grok-build-agent',     planId: 'paid', medium: 'agent' },
];

for (const cfg of SCRAPERS) {
  const { id, displayName } = cfg;

  console.log(`${displayName} — planMessages`);
  { const s = makeScraper(cfg); const m = s.planMessages('run-1'); check(`${id}: returns one message`, m.length === 1); check(`${id}: kind is ${id}`, m[0].kind === id); check(`${id}: runId is set`, m[0].runId === 'run-1'); }

  console.log(`${displayName} — doHandle with models`);
  { const s = makeScraper(cfg); const db = new MockDB();
    const envKey = id.replace(/-/g, '_').toUpperCase() + '_API_KEY';
    const r = await s.handle({ kind: id, runId: 'r1', payload: {} }, { DB: db, CACHE: {}, [envKey]: 'test-key' });
    check(`${id}: offering count`, r.offerings === cfg.models.length); check(`${id}: 0 scores`, r.scores === 0);
    check(`${id}: health is ok`, s.health().lastStatus === 'ok'); check(`${id}: modelsFound=${cfg.models.length}`, s.health().modelsFound === cfg.models.length); }

  console.log(`${displayName} — error handling`);
  { const s = makeScraper(cfg); const db = new MockDB();
    try { await s.handle({ kind: id, runId: 'r1', payload: {} }, { DB: db, CACHE: {} }); check(`${id}: throws for missing key`, false); }
    catch (e) { const envKey = id.replace(/-/g, '_').toUpperCase() + '_API_KEY'; check(`${id}: throws for missing key`, e.message === `${envKey} not set`); check(`${id}: error status`, s.health().lastStatus === 'error'); } }

  console.log('');
}

console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
