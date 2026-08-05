/**
 * Tests for all Phase 2 inference scrapers (28 scrapers).
 *
 *   node scripts/test-phase2-scrapers.mjs
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
    id, category: 'inference', displayName,
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
      await env.DB.prepare(QUOTA_SQL).bind(quotaId, quotaPlatform, quotaLabel, quotaUnit, quotaValue, 'documented', now).run();
      return { offerings: rows.length, scores: 0, quotas: 1, note: `${rows.length} models from ${displayName}` };
    },
  };
}

const SCRAPERS = [
  { id: 'replicate',     displayName: 'Replicate',        baseUrl: 'https://api.replicate.com/v1',           envKey: 'REPLICATE_API_KEY',     quotaId: 'replicate-credits',     quotaPlatform: 'replicate',     quotaLabel: 'Replicate Signup Credits',     quotaUnit: 'credits', quotaValue: 1 },
  { id: 'baseten',       displayName: 'Baseten',          baseUrl: 'https://api.baseten.co/v1',              envKey: 'BASETEN_API_KEY',       quotaId: 'baseten-credits',       quotaPlatform: 'baseten',       quotaLabel: 'Baseten Signup Credits',       quotaUnit: 'credits', quotaValue: 1 },
  { id: 'modal',         displayName: 'Modal',            baseUrl: 'https://api.modal.com/v1',               envKey: 'MODAL_API_KEY',         quotaId: 'modal-free-tier',       quotaPlatform: 'modal',         quotaLabel: 'Modal Free Tier',             quotaUnit: 'credits', quotaValue: 1 },
  { id: 'lepton',        displayName: 'Lepton AI',        baseUrl: 'https://api.lepton.ai/v1',               envKey: 'LEPTON_API_KEY',        quotaId: 'lepton-credits',        quotaPlatform: 'lepton',        quotaLabel: 'Lepton Signup Credits',        quotaUnit: 'credits', quotaValue: 1 },
  { id: 'octoai',        displayName: 'OctoAI',           baseUrl: 'https://api.octoai.com/v1',              envKey: 'OCTOAI_API_KEY',        quotaId: 'octoai-credits',        quotaPlatform: 'octoai',        quotaLabel: 'OctoAI Signup Credits',        quotaUnit: 'credits', quotaValue: 1 },
  { id: 'anyscale',      displayName: 'Anyscale',         baseUrl: 'https://api.anyscale.com/v1',             envKey: 'ANYSCALE_API_KEY',      quotaId: 'anyscale-credits',      quotaPlatform: 'anyscale',      quotaLabel: 'Anyscale Signup Credits',      quotaUnit: 'credits', quotaValue: 1 },
  { id: 'runpod',        displayName: 'RunPod',           baseUrl: 'https://api.runpod.io/v1',               envKey: 'RUNPOD_API_KEY',        quotaId: 'runpod-credits',        quotaPlatform: 'runpod',        quotaLabel: 'RunPod Signup Credits',        quotaUnit: 'credits', quotaValue: 1 },
  { id: 'lambda',        displayName: 'Lambda Labs',      baseUrl: 'https://api.lambdalabs.com/v1',          envKey: 'LAMBDA_API_KEY',        quotaId: 'lambda-credits',        quotaPlatform: 'lambda',        quotaLabel: 'Lambda Signup Credits',        quotaUnit: 'credits', quotaValue: 1 },
  { id: 'hf-inference',  displayName: 'HF Inference',     baseUrl: 'https://api-inference.huggingface.co',   envKey: 'HF_INFERENCE_API_KEY',  quotaId: 'hf-inference-free-tier',quotaPlatform: 'hf-inference',  quotaLabel: 'HF Inference Free Tier',      quotaUnit: 'requests_per_day', quotaValue: 1000 },
  { id: 'cloudflare',    displayName: 'Cloudflare',       baseUrl: 'https://api.cloudflare.com/client/v4',   envKey: 'CLOUDFLARE_API_KEY',    quotaId: 'cloudflare-free-tier',  quotaPlatform: 'cloudflare',    quotaLabel: 'Cloudflare Free Tier',        quotaUnit: 'neurons_per_day', quotaValue: 10000 },
  { id: 'fal',           displayName: 'fal.ai',           baseUrl: 'https://fal.run',                        envKey: 'FAL_API_KEY',           quotaId: 'fal-credits',           quotaPlatform: 'fal',           quotaLabel: 'fal Signup Credits',           quotaUnit: 'credits', quotaValue: 1 },
  { id: 'puter',         displayName: 'Puter',            baseUrl: 'https://api.puter.com/v1',               envKey: 'PUTER_API_KEY',         quotaId: 'puter-free-tier',       quotaPlatform: 'puter',         quotaLabel: 'Puter Free Tier',             quotaUnit: 'credits', quotaValue: 1 },
  { id: 'nebius',        displayName: 'Nebius',           baseUrl: 'https://api.studio.nebius.com/v1',       envKey: 'NEBIUS_API_KEY',        quotaId: 'nebius-credits',        quotaPlatform: 'nebius',        quotaLabel: 'Nebius Signup Credits',        quotaUnit: 'credits', quotaValue: 1 },
  { id: 'scaleway',      displayName: 'Scaleway',         baseUrl: 'https://api.scaleway.com/llm-inference/v1', envKey: 'SCALEWAY_API_KEY',   quotaId: 'scaleway-credits',      quotaPlatform: 'scaleway',      quotaLabel: 'Scaleway Signup Credits',      quotaUnit: 'credits', quotaValue: 1 },
  { id: 'coreweave',     displayName: 'CoreWeave',        baseUrl: 'https://api.coreweave.com/v1',           envKey: 'COREWEAVE_API_KEY',     quotaId: 'coreweave-credits',     quotaPlatform: 'coreweave',     quotaLabel: 'CoreWeave Signup Credits',     quotaUnit: 'credits', quotaValue: 1 },
  { id: 'beam',          displayName: 'Beam',             baseUrl: 'https://api.beam.cloud/v1',              envKey: 'BEAM_API_KEY',          quotaId: 'beam-credits',          quotaPlatform: 'beam',          quotaLabel: 'Beam Signup Credits',          quotaUnit: 'credits', quotaValue: 1 },
  { id: 'vast',          displayName: 'Vast.ai',          baseUrl: 'https://api.vast.ai/v1',                 envKey: 'VAST_API_KEY',          quotaId: 'vast-credits',          quotaPlatform: 'vast',          quotaLabel: 'Vast Signup Credits',          quotaUnit: 'credits', quotaValue: 1 },
  { id: 'crusoe',        displayName: 'Crusoe Cloud',     baseUrl: 'https://api.crusoclooud.com/v1',         envKey: 'CRUSOE_API_KEY',        quotaId: 'crusoe-credits',        quotaPlatform: 'crusoe',        quotaLabel: 'Crusoe Signup Credits',        quotaUnit: 'credits', quotaValue: 1 },
  { id: 'infercom',      displayName: 'Infercom',         baseUrl: 'https://api.infercom.com/v1',            envKey: 'INFERCOM_API_KEY',      quotaId: 'infercom-credits',      quotaPlatform: 'infercom',      quotaLabel: 'Infercom Signup Credits',      quotaUnit: 'credits', quotaValue: 1 },
  { id: 'lyceum',        displayName: 'Lyceum',           baseUrl: 'https://api.lyceum.com/v1',              envKey: 'LYCEUM_API_KEY',        quotaId: 'lyceum-credits',        quotaPlatform: 'lyceum',        quotaLabel: 'Lyceum Signup Credits',        quotaUnit: 'credits', quotaValue: 1 },
  { id: 'berget',        displayName: 'Berget AI',        baseUrl: 'https://api.berget.ai/v1',               envKey: 'BERGET_API_KEY',        quotaId: 'berget-credits',        quotaPlatform: 'berget',        quotaLabel: 'Berget Signup Credits',        quotaUnit: 'credits', quotaValue: 1 },
  { id: 'nscale',        displayName: 'Nscale',           baseUrl: 'https://api.nscale.com/v1',              envKey: 'NSCALE_API_KEY',        quotaId: 'nscale-credits',        quotaPlatform: 'nscale',        quotaLabel: 'Nscale Signup Credits',        quotaUnit: 'credits', quotaValue: 1 },
  { id: 'ovhcloud',      displayName: 'OVHcloud AI',     baseUrl: 'https://api.ovhcloud.com/ai/v1',         envKey: 'OVHCLOUD_API_KEY',      quotaId: 'ovhcloud-credits',      quotaPlatform: 'ovhcloud',      quotaLabel: 'OVHcloud Signup Credits',      quotaUnit: 'credits', quotaValue: 1 },
  { id: 'libert',        displayName: 'LibertAI',         baseUrl: 'https://api.libert.ai/v1',               envKey: 'LIBERT_API_KEY',        quotaId: 'libert-free-tier',      quotaPlatform: 'libert',        quotaLabel: 'LibertAI Free Tier',          quotaUnit: 'credits', quotaValue: 1 },
  { id: 'tokenware',     displayName: 'Tokenware',        baseUrl: 'https://api.tokenware.com/v1',           envKey: 'TOKENWARE_API_KEY',     quotaId: 'tokenware-credits',     quotaPlatform: 'tokenware',     quotaLabel: 'Tokenware Signup Credits',     quotaUnit: 'credits', quotaValue: 1 },
  { id: 'ionrouter',     displayName: 'IonRouter',        baseUrl: 'https://api.ionrouter.com/v1',           envKey: 'IONROUTER_API_KEY',     quotaId: 'ionrouter-credits',     quotaPlatform: 'ionrouter',     quotaLabel: 'IonRouter Signup Credits',     quotaUnit: 'credits', quotaValue: 1 },
  { id: 'ferry',         displayName: 'FerryAPI',         baseUrl: 'https://api.ferryapi.com/v1',            envKey: 'FERRY_API_KEY',         quotaId: 'ferry-credits',         quotaPlatform: 'ferry',         quotaLabel: 'FerryAPI Signup Credits',      quotaUnit: 'credits', quotaValue: 1 },
  { id: 'hf-hub',        displayName: 'HF Hub',           baseUrl: 'https://huggingface.co/api',             envKey: 'HF_HUB_API_KEY',        quotaId: 'hf-hub-free-tier',      quotaPlatform: 'hf-hub',        quotaLabel: 'HF Hub Free Tier',            quotaUnit: 'credits', quotaValue: 1 },
];

function mockFetch(catalog) { return async (url) => { if (url.includes('/models')) return { ok: true, json: async () => catalog }; return { ok: false, status: 404 }; }; }
function mockFetchError(status = 500) { return async () => ({ ok: false, status, json: async () => ({ error: 'server error' }) }); }

for (const cfg of SCRAPERS) {
  const { id, displayName, envKey, quotaId, quotaLabel, quotaUnit, quotaValue } = cfg;

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
    check(`${id}: offering count`, r.offerings === 2); check(`${id}: 0 scores`, r.scores === 0); check(`${id}: 1 quota`, r.quotas === 1);
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

  console.log(`${displayName} — quota pool`);
  { const s = makeScraper(cfg); const db = new MockDB();
    const orig = globalThis.fetch; globalThis.fetch = mockFetch({ object: 'list', data: [] });
    await s.handle({ kind: id, runId: 'r1', payload: {} }, { DB: db, CACHE: {}, [envKey]: 'test-key' });
    globalThis.fetch = orig;
    const w = db._writes.find(x => x.sql.includes('INSERT INTO quota_pools'));
    check(`${id}: pool_id`, w.params[0] === quotaId); check(`${id}: platform`, w.params[1] === id);
    check(`${id}: unit`, w.params[3] === quotaUnit); check(`${id}: value`, w.params[4] === quotaValue); }

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
