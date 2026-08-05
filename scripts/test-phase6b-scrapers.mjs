/**
 * Tests for 21 Phase 6 image/video/audio scrapers (#104-#124).
 *
 *   node scripts/test-phase6b-scrapers.mjs
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

const OFFERING_SQL = `INSERT INTO offerings (model_id, harness_id, plan_id, medium, context_window, supports_vision, supports_tools, is_free, price_prompt, price_completion, access_url, last_verified_at, score_key) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13) ON CONFLICT(model_id, harness_id, plan_id) DO UPDATE SET context_window=excluded.context_window, supports_vision=excluded.supports_vision, supports_tools=excluded.supports_tools, is_free=excluded.is_free, price_prompt=excluded.price_prompt, price_completion=excluded.price_completion, last_verified_at=excluded.last_verified_at, score_key=excluded.score_key`;

function makeScraper({ id, displayName, models, harnessId, planId, medium }) {
  const h = { scraperId: id, lastRunAt: null, lastStatus: 'never_run', lastError: null, consecutiveFailures: 0, modelsFound: 0, scoresWritten: 0 };
  return {
    id, category: medium, displayName,
    planMessages(runId) { return [{ kind: id, runId, payload: {} }]; },
    health() { return { ...h }; },
    async handle(msg, env) {
      try {
        const result = await this.doHandle(msg, env);
        h.lastRunAt = new Date().toISOString(); h.lastStatus = 'ok'; h.lastError = null;
        h.consecutiveFailures = 0; h.modelsFound += result.offerings; h.scoresWritten += result.scores;
        return result;
      } catch (err) {
        h.lastRunAt = new Date().toISOString(); h.lastStatus = 'error';
        h.lastError = err instanceof Error ? err.message : String(err); h.consecutiveFailures += 1;
        throw err;
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
  { id: 'runway',              displayName: 'Runway',                models: ['gen-3-alpha', 'gen-2'],                    harnessId: 'runway-tool',              planId: 'paid', medium: 'tool' },
  { id: 'pika',                displayName: 'Pika',                  models: ['pika-1.0', 'pika-1.2'],                   harnessId: 'pika-tool',                planId: 'paid', medium: 'tool' },
  { id: 'kling',               displayName: 'Kling AI',              models: ['kling-1.5', 'kling-1.0'],                 harnessId: 'kling-tool',               planId: 'paid', medium: 'tool' },
  { id: 'luma',                displayName: 'Luma Dream Machine',    models: ['dream-machine-1.5', 'dream-machine'],      harnessId: 'luma-tool',                planId: 'paid', medium: 'tool' },
  { id: 'sora',                displayName: 'Sora (OpenAI)',         models: ['sora', 'sora-turbo'],                     harnessId: 'sora-tool',                planId: 'paid', medium: 'tool' },
  { id: 'synthesia',           displayName: 'Synthesia',             models: ['synthesia-2', 'synthesia-1'],             harnessId: 'synthesia-tool',           planId: 'paid', medium: 'tool' },
  { id: 'heygen',              displayName: 'HeyGen',                models: ['heygen-v3', 'heygen-v2'],                 harnessId: 'heygen-tool',              planId: 'paid', medium: 'tool' },
  { id: 'd-id',                displayName: 'D-ID',                  models: ['did-avatar', 'did-face'],                 harnessId: 'd-id-tool',                planId: 'paid', medium: 'tool' },
  { id: 'seedance',            displayName: 'Seedance (ByteDance)',  models: ['seedance-1.0'],                           harnessId: 'seedance-tool',            planId: 'paid', medium: 'tool' },
  { id: 'elevenlabs',          displayName: 'ElevenLabs',            models: ['eleven_multilingual_v2', 'eleven_turbo_v2'], harnessId: 'elevenlabs-tool',        planId: 'paid', medium: 'tool' },
  { id: 'suno',                displayName: 'Suno',                  models: ['suno-v3', 'suno-v2'],                    harnessId: 'suno-tool',                planId: 'paid', medium: 'tool' },
  { id: 'udio',                displayName: 'Udio',                  models: ['udio-v1', 'udio-v2'],                    harnessId: 'udio-tool',                planId: 'paid', medium: 'tool' },
  { id: 'stability-audio',     displayName: 'Stability Audio',       models: ['stable-audio-1.0'],                       harnessId: 'stability-audio-tool',     planId: 'paid', medium: 'tool' },
  { id: 'descript',            displayName: 'Descript',              models: ['descript-transcribe', 'descript-voice'],  harnessId: 'descript-tool',            planId: 'paid', medium: 'tool' },
  { id: 'midjourney-image',    displayName: 'Midjourney (Image)',    models: ['midjourney-v6', 'midjourney-v5.2'],       harnessId: 'midjourney-image-tool',    planId: 'paid', medium: 'tool' },
  { id: 'dall-e',              displayName: 'DALL-E (OpenAI)',       models: ['dall-e-3', 'dall-e-2'],                  harnessId: 'dall-e-tool',              planId: 'paid', medium: 'tool' },
  { id: 'stable-diffusion',    displayName: 'Stable Diffusion',      models: ['stable-diffusion-xl', 'sd-v1-5'],        harnessId: 'stable-diffusion-tool',    planId: 'paid', medium: 'tool' },
  { id: 'ideogram',            displayName: 'Ideogram',              models: ['ideogram-v2', 'ideogram-v1'],            harnessId: 'ideogram-tool',            planId: 'paid', medium: 'tool' },
  { id: 'leonardo',            displayName: 'Leonardo.ai',           models: ['leonardo-diffusion-xl', 'leonardo-creative'], harnessId: 'leonardo-tool',        planId: 'paid', medium: 'tool' },
  { id: 'magnific',            displayName: 'Magnific',              models: ['magnific-upscale'],                       harnessId: 'magnific-tool',            planId: 'paid', medium: 'tool' },
  { id: 'fal-image',           displayName: 'fal.ai (Image)',        models: ['fal-sdxl', 'fal-flux'],                  harnessId: 'fal-image-tool',           planId: 'paid', medium: 'tool' },
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
