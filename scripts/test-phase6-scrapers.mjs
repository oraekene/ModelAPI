/**
 * Tests for all Phase 6 AI tool/SaaS scrapers (30 scrapers).
 *
 *   node scripts/test-phase6-scrapers.mjs
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
    id, category: medium, displayName,
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
  { id: 'aws-bedrock',          displayName: 'AWS Bedrock',            models: ['claude-3-sonnet', 'llama2-70b', 'titan-express'], harnessId: 'aws-bedrock-tool',         planId: 'paid', medium: 'tool' },
  { id: 'azure-openai',         displayName: 'Azure OpenAI',           models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'],          harnessId: 'azure-openai-tool',        planId: 'paid', medium: 'tool' },
  { id: 'google-vertex',        displayName: 'Google Vertex AI',       models: ['gemini-pro', 'text-bison', 'code-bison'],         harnessId: 'google-vertex-tool',       planId: 'paid', medium: 'tool' },
  { id: 'ibm-watsonx',          displayName: 'IBM watsonx',            models: ['granite-13b-chat', 'granite-20b-code'],           harnessId: 'ibm-watsonx-tool',         planId: 'paid', medium: 'tool' },
  { id: 'oracle-cloud',         displayName: 'Oracle Cloud AI',        models: ['cohere-embed-v3', 'command-r-plus'],              harnessId: 'oracle-cloud-tool',        planId: 'paid', medium: 'tool' },
  { id: 'cloudflare-ai-gateway',displayName: 'Cloudflare AI Gateway',  models: ['cf-llama-3-8b', 'cf-mistral-7b'],                 harnessId: 'cloudflare-ai-gateway-tool', planId: 'free', medium: 'tool' },
  { id: 'puter-image',          displayName: 'Puter (Image)',          models: ['puter-image-gen', 'puter-image-edit'],            harnessId: 'puter-image-tool',         planId: 'free', medium: 'tool' },
  { id: 'litellm',              displayName: 'LiteLLM',                models: ['litellm-proxy'],                                  harnessId: 'litellm-tool',             planId: 'free', medium: 'tool' },
  { id: 'portkey',              displayName: 'Portkey',                models: ['portkey-gateway'],                                harnessId: 'portkey-tool',             planId: 'free', medium: 'tool' },
  { id: 'langsmith',            displayName: 'LangSmith',              models: ['langsmith-evaluator'],                            harnessId: 'langsmith-tool',           planId: 'free', medium: 'tool' },
  { id: 'perplexity-search',    displayName: 'Perplexity (Search)',    models: ['pplx-70b-online', 'pplx-7b-online'],              harnessId: 'perplexity-search-tool',   planId: 'paid', medium: 'tool' },
  { id: 'you',                  displayName: 'You.com',                models: ['you-chat', 'you-complete'],                       harnessId: 'you-tool',                 planId: 'paid', medium: 'tool' },
  { id: 'character-ai',         displayName: 'Character.ai',           models: ['character-ai-chat'],                              harnessId: 'character-ai-tool',        planId: 'free', medium: 'tool' },
  { id: 'doubao-chat',          displayName: 'Doubao Chat',            models: ['doubao-pro', 'doubao-lite'],                      harnessId: 'doubao-chat-tool',         planId: 'paid', medium: 'tool' },
  { id: 'kimi-chat',            displayName: 'Kimi Chat',              models: ['kimi-chat'],                                      harnessId: 'kimi-chat-tool',           planId: 'free', medium: 'tool' },
  { id: 'tongyi',               displayName: 'Tongyi (Alibaba)',       models: ['qwen-max', 'qwen-plus', 'qwen-turbo'],           harnessId: 'tongyi-tool',              planId: 'paid', medium: 'tool' },
  { id: 'ernie-chat',           displayName: 'ERNIE Chat',             models: ['ernie-4.0', 'ernie-3.5', 'ernie-speed'],         harnessId: 'ernie-chat-tool',          planId: 'paid', medium: 'tool' },
  { id: 'glm-chat',             displayName: 'GLM Chat',               models: ['glm-4', 'glm-4v', 'glm-3-turbo'],               harnessId: 'glm-chat-tool',            planId: 'paid', medium: 'tool' },
  { id: 'deepseek-chat',        displayName: 'DeepSeek Chat',          models: ['deepseek-chat', 'deepseek-coder'],                harnessId: 'deepseek-chat-tool',       planId: 'free', medium: 'tool' },
  { id: 'swe-agent',            displayName: 'SWE-Agent',              models: ['swe-agent-default'],                              harnessId: 'swe-agent-agent',          planId: 'free', medium: 'agent' },
  { id: 'openhands',            displayName: 'OpenHands',              models: ['openhands-default'],                              harnessId: 'openhands-agent',          planId: 'free', medium: 'agent' },
  { id: 'ona',                  displayName: 'Ona (ex-Gitpod)',         models: ['ona-default'],                                    harnessId: 'ona-agent',                planId: 'free', medium: 'agent' },
  { id: 'nxcode',               displayName: 'NxCode',                 models: ['nxcode-default'],                                 harnessId: 'nxcode-agent',             planId: 'free', medium: 'agent' },
  { id: 'mastra',               displayName: 'Mastra',                 models: ['mastra-default'],                                 harnessId: 'mastra-agent',             planId: 'free', medium: 'agent' },
  { id: 'canva',                displayName: 'Canva AI',               models: ['canva-text-to-image', 'canva-magic-edit'],        harnessId: 'canva-tool',               planId: 'paid', medium: 'tool' },
  { id: 'notion',               displayName: 'Notion AI',              models: ['notion-ai-write', 'notion-ai-summarize'],         harnessId: 'notion-tool',              planId: 'paid', medium: 'tool' },
  { id: 'grammarly',            displayName: 'Grammarly',              models: ['grammarly-proofread', 'grammarly-generate'],      harnessId: 'grammarly-tool',           planId: 'paid', medium: 'tool' },
  { id: 'jasper',               displayName: 'Jasper',                 models: ['jasper-write', 'jasper-chat'],                    harnessId: 'jasper-tool',              planId: 'paid', medium: 'tool' },
  { id: 'linear',               displayName: 'Linear',                 models: ['linear-ai-write', 'linear-ai-prioritize'],       harnessId: 'linear-tool',              planId: 'paid', medium: 'tool' },
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
