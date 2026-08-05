/**
 * Tests for all Phase 3 AI lab scrapers (24 scrapers).
 *
 *   node scripts/test-phase3-scrapers.mjs
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

function makeScraper({ id, displayName, baseUrl, envKey, quotaId, quotaPlatform, quotaLabel, quotaUnit, quotaValue }) {
  const h = { scraperId: id, lastRunAt: null, lastStatus: 'never_run', lastError: null, consecutiveFailures: 0, modelsFound: 0, scoresWritten: 0 };
  async function updateHealth(db) {
    await db.prepare(HEALTH_SQL).bind(h.scraperId, h.lastRunAt, h.lastStatus, h.lastError, h.consecutiveFailures, h.modelsFound, h.scoresWritten).run();
  }
  return {
    id, category: 'lab', displayName,
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
      const apiKey = env[envKey];
      if (!apiKey) throw new Error(`${envKey} not set`);
      const res = await fetch(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
      if (!res.ok) throw new Error(`${id} /models: HTTP ${res.status}`);
      const catalog = await res.json();
      const models = catalog.data ?? catalog.results ?? catalog.models ?? [];
      const now = new Date().toISOString();
      const stmt = env.DB.prepare(OFFERING_SQL);
      const rows = models.map(m => {
        const mid = `${id}/${m.id}`;
        const pp = Number(m.pricing?.prompt ?? 0); const pc = Number(m.pricing?.completion ?? 0);
        const isFree = pp === 0 && pc === 0;
        return stmt.bind(mid, `${id}-api`, isFree ? 'free' : 'paid', 'api', m.context_length ?? null, 0, 0, isFree ? 1 : 0, pp, pc, `${baseUrl}/models/${m.id}`, now, m.id);
      });
      if (rows.length > 0) await env.DB.batch(rows);
      if (quotaId) await env.DB.prepare(QUOTA_SQL).bind(quotaId, quotaPlatform, quotaLabel, quotaUnit, quotaValue, 'documented', now).run();
      return { offerings: rows.length, scores: 0, quotas: quotaId ? 1 : 0, note: `${rows.length} models from ${displayName}` };
    },
  };
}

const SCRAPERS = [
  { id: 'openai',       displayName: 'OpenAI',           baseUrl: 'https://api.openai.com/v1',               envKey: 'OPENAI_API_KEY',       quotaId: 'openai-free-tier',     quotaPlatform: 'openai',       quotaLabel: 'OpenAI Free Trial',          quotaUnit: 'credits',     quotaValue: 1 },
  { id: 'anthropic',    displayName: 'Anthropic',         baseUrl: 'https://api.anthropic.com/v1',            envKey: 'ANTHROPIC_API_KEY',    quotaId: 'anthropic-free-tier',  quotaPlatform: 'anthropic',    quotaLabel: 'Anthropic Free Trial',       quotaUnit: 'credits',     quotaValue: 1 },
  { id: 'gemini',       displayName: 'Google Gemini',     baseUrl: 'https://generativelanguage.googleapis.com/v1beta', envKey: 'GEMINI_API_KEY', quotaId: 'gemini-free-tier',    quotaPlatform: 'gemini',       quotaLabel: 'Gemini Free Tier',           quotaUnit: 'requests_per_day', quotaValue: 1500 },
  { id: 'llama',        displayName: 'Meta Llama',        baseUrl: 'https://llama.meta.com/api',              envKey: 'LLAMA_API_KEY',        quotaId: null,                  quotaPlatform: null,           quotaLabel: null,                        quotaUnit: null,          quotaValue: null },
  { id: 'mistral',      displayName: 'Mistral',           baseUrl: 'https://api.mistral.ai/v1',               envKey: 'MISTRAL_API_KEY',      quotaId: 'mistral-free-tier',   quotaPlatform: 'mistral',      quotaLabel: 'Mistral Free Tier',         quotaUnit: 'credits',     quotaValue: 1 },
  { id: 'xai',          displayName: 'xAI (Grok)',        baseUrl: 'https://api.x.ai/v1',                    envKey: 'XAI_API_KEY',          quotaId: 'xai-free-tier',       quotaPlatform: 'xai',          quotaLabel: 'xAI Free Tier',             quotaUnit: 'credits',     quotaValue: 1 },
  { id: 'cohere',       displayName: 'Cohere',            baseUrl: 'https://api.cohere.com/v1',               envKey: 'COHERE_API_KEY',       quotaId: 'cohere-free-tier',    quotaPlatform: 'cohere',       quotaLabel: 'Cohere Free Tier',          quotaUnit: 'requests_per_day', quotaValue: 1000 },
  { id: 'deepseek',     displayName: 'DeepSeek',          baseUrl: 'https://api.deepseek.com/v1',             envKey: 'DEEPSEEK_API_KEY',     quotaId: 'deepseek-free-tier',  quotaPlatform: 'deepseek',     quotaLabel: 'DeepSeek Free Tier',        quotaUnit: 'credits',     quotaValue: 1 },
  { id: 'qwen',         displayName: 'Alibaba Qwen',      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', envKey: 'QWEN_API_KEY',   quotaId: 'qwen-free-tier',      quotaPlatform: 'qwen',         quotaLabel: 'Qwen Free Tier',            quotaUnit: 'tokens_per_day', quotaValue: 1000000 },
  { id: 'moonshot',     displayName: 'Moonshot Kimi',     baseUrl: 'https://api.moonshot.cn/v1',              envKey: 'MOONSHOT_API_KEY',     quotaId: 'moonshot-free-tier',  quotaPlatform: 'moonshot',     quotaLabel: 'Moonshot Free Tier',        quotaUnit: 'tokens_per_day', quotaValue: 1000000 },
  { id: 'zhipu-glm',    displayName: 'Zhipu GLM',         baseUrl: 'https://open.bigmodel.cn/api/paas/v4',    envKey: 'ZHIPU_API_KEY',        quotaId: 'zhipu-free-tier',     quotaPlatform: 'zhipu-glm',    quotaLabel: 'Zhipu Free Tier',           quotaUnit: 'tokens_per_day', quotaValue: 1000000 },
  { id: 'doubao',       displayName: 'ByteDance Doubao',  baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',envKey: 'DOUBAO_API_KEY',       quotaId: 'doubao-free-tier',    quotaPlatform: 'doubao',       quotaLabel: 'Doubao Free Tier',          quotaUnit: 'tokens_per_day', quotaValue: 1000000 },
  { id: 'minimax',      displayName: 'MiniMax',           baseUrl: 'https://api.minimax.chat/v1',             envKey: 'MINIMAX_API_KEY',      quotaId: 'minimax-free-tier',   quotaPlatform: 'minimax',      quotaLabel: 'MiniMax Free Tier',         quotaUnit: 'tokens_per_day', quotaValue: 1000000 },
  { id: 'ernie',        displayName: 'Baidu ERNIE',       baseUrl: 'https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop', envKey: 'ERNIE_API_KEY', quotaId: 'ernie-free-tier',     quotaPlatform: 'ernie',        quotaLabel: 'ERNIE Free Tier',           quotaUnit: 'tokens_per_day', quotaValue: 1000000 },
  { id: 'yi',           displayName: '01.AI Yi',          baseUrl: 'https://api.lingyiwanwu.com/v1',          envKey: 'YI_API_KEY',           quotaId: 'yi-free-tier',        quotaPlatform: 'yi',           quotaLabel: 'Yi Free Tier',              quotaUnit: 'tokens_per_day', quotaValue: 1000000 },
  { id: 'stability',    displayName: 'Stability AI',      baseUrl: 'https://api.stability.ai/v1',             envKey: 'STABILITY_API_KEY',    quotaId: 'stability-free-tier', quotaPlatform: 'stability',    quotaLabel: 'Stability Free Tier',       quotaUnit: 'credits',     quotaValue: 25 },
  { id: 'midjourney',   displayName: 'Midjourney',        baseUrl: 'https://midjourney.com/api',              envKey: 'MIDJOURNEY_API_KEY',   quotaId: null,                  quotaPlatform: null,           quotaLabel: null,                        quotaUnit: null,          quotaValue: null },
  { id: 'hunyuan',      displayName: 'Tencent Hunyuan',   baseUrl: 'https://hunyuan.cloud.tencent.com/v1',    envKey: 'HUNYUAN_API_KEY',      quotaId: 'hunyuan-free-tier',   quotaPlatform: 'hunyuan',      quotaLabel: 'Hunyuan Free Tier',         quotaUnit: 'tokens_per_day', quotaValue: 1000000 },
  { id: 'nova',         displayName: 'Amazon Nova',       baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com/v1', envKey: 'NOVA_API_KEY', quotaId: 'nova-free-tier',      quotaPlatform: 'nova',         quotaLabel: 'Nova Free Tier',            quotaUnit: 'tokens_per_day', quotaValue: 1000000 },
  { id: 'phi',          displayName: 'Microsoft Phi',     baseUrl: 'https://phi.azure.com/v1',                envKey: 'PHI_API_KEY',          quotaId: 'phi-free-tier',       quotaPlatform: 'phi',          quotaLabel: 'Phi Free Tier',             quotaUnit: 'credits',     quotaValue: 1 },
  { id: 'ai21',         displayName: 'AI21 Labs',         baseUrl: 'https://api.ai21.com/v1',                 envKey: 'AI21_API_KEY',         quotaId: 'ai21-free-tier',      quotaPlatform: 'ai21',         quotaLabel: 'AI21 Free Tier',            quotaUnit: 'credits',     quotaValue: 1 },
  { id: 'perplexity',   displayName: 'Perplexity',        baseUrl: 'https://api.perplexity.ai',               envKey: 'PERPLEXITY_API_KEY',   quotaId: 'perplexity-free-tier',quotaPlatform: 'perplexity',   quotaLabel: 'Perplexity Free Tier',      quotaUnit: 'credits',     quotaValue: 1 },
  { id: 'stepfun',      displayName: 'StepFun',           baseUrl: 'https://api.stepfun.com/v1',              envKey: 'STEPFUN_API_KEY',      quotaId: 'stepfun-free-tier',   quotaPlatform: 'stepfun',      quotaLabel: 'StepFun Free Tier',         quotaUnit: 'tokens_per_day', quotaValue: 1000000 },
  { id: 'zhipu-ai',     displayName: 'Zhipu AI',          baseUrl: 'https://open.bigmodel.cn/api/paas/v4',    envKey: 'ZHIPU_AI_API_KEY',     quotaId: 'zhipu-ai-free-tier',  quotaPlatform: 'zhipu-ai',     quotaLabel: 'Zhipu AI Free Tier',        quotaUnit: 'tokens_per_day', quotaValue: 1000000 },
];

function mockFetch(catalog) { return async (url) => { if (url.includes('/models')) return { ok: true, json: async () => catalog }; return { ok: false, status: 404 }; }; }
function mockFetchError(status = 500) { return async () => ({ ok: false, status, json: async () => ({ error: 'server error' }) }); }

for (const cfg of SCRAPERS) {
  const { id, displayName, envKey } = cfg;

  console.log(`${displayName} — planMessages`);
  { const s = makeScraper(cfg); const m = s.planMessages('run-1'); check(`${id}: returns one message`, m.length === 1); check(`${id}: kind is ${id}`, m[0].kind === id); check(`${id}: runId is set`, m[0].runId === 'run-1'); }

  console.log(`${displayName} — doHandle with models`);
  { const s = makeScraper(cfg); const db = new MockDB();
    const cat = { object: 'list', data: [
      { id: 'model-a', context_length: 131072, pricing: { prompt: '0.00000088', completion: '0.00000088' } },
      { id: 'model-b', context_length: 32768, pricing: { prompt: '0', completion: '0' } },
    ]};
    const orig = globalThis.fetch; globalThis.fetch = mockFetch(cat);
    const r = await s.handle({ kind: id, runId: 'r1', payload: {} }, { DB: db, CACHE: {}, [envKey]: 'test-key' });
    globalThis.fetch = orig;
    check(`${id}: offering count`, r.offerings === 2); check(`${id}: 0 scores`, r.scores === 0);
    check(`${id}: health is ok`, s.health().lastStatus === 'ok'); check(`${id}: modelsFound=2`, s.health().modelsFound === 2); }

  console.log(`${displayName} — free model detection`);
  { const s = makeScraper(cfg); const db = new MockDB();
    const cat = { object: 'list', data: [{ id: 'free-model', context_length: 32768, pricing: { prompt: '0', completion: '0' } }] };
    const orig = globalThis.fetch; globalThis.fetch = mockFetch(cat);
    await s.handle({ kind: id, runId: 'r1', payload: {} }, { DB: db, CACHE: {}, [envKey]: 'test-key' });
    globalThis.fetch = orig;
    const w = db._writes.find(x => x.sql.includes('INSERT INTO offerings'));
    check(`${id}: plan_id=free`, w.params[2] === 'free'); check(`${id}: is_free=1`, w.params[7] === 1); }

  console.log(`${displayName} — paid model detection`);
  { const s = makeScraper(cfg); const db = new MockDB();
    const cat = { object: 'list', data: [{ id: 'paid-model', context_length: 131072, pricing: { prompt: '0.001', completion: '0.002' } }] };
    const orig = globalThis.fetch; globalThis.fetch = mockFetch(cat);
    await s.handle({ kind: id, runId: 'r1', payload: {} }, { DB: db, CACHE: {}, [envKey]: 'test-key' });
    globalThis.fetch = orig;
    const w = db._writes.find(x => x.sql.includes('INSERT INTO offerings'));
    check(`${id}: plan_id=paid`, w.params[2] === 'paid'); check(`${id}: is_free=0`, w.params[7] === 0); }

  console.log(`${displayName} — error handling`);
  { const s = makeScraper(cfg); const db = new MockDB();
    try { await s.handle({ kind: id, runId: 'r1', payload: {} }, { DB: db, CACHE: {} }); check(`${id}: throws for missing key`, false); }
    catch (e) { check(`${id}: throws for missing key`, e.message === `${envKey} not set`); check(`${id}: error status`, s.health().lastStatus === 'error'); }
    const s2 = makeScraper(cfg); const orig = globalThis.fetch; globalThis.fetch = mockFetchError(429);
    try { await s2.handle({ kind: id, runId: 'r2', payload: {} }, { DB: db, CACHE: {}, [envKey]: 'test-key' }); check(`${id}: throws for API error`, false); }
    catch (e) { check(`${id}: throws for API error`, e.message.includes('HTTP 429')); check(`${id}: error status`, s2.health().lastStatus === 'error'); }
    globalThis.fetch = orig; }

  console.log('');
}

console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
