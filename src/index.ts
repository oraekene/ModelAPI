/**
 * ModelMap — sync + rank worker (build steps 3 and 4).
 *
 * CPU BUDGET: Workers Free allows 10 ms CPU per invocation, cron included.
 * Every handler here must stay well under that. The rule is: fetch in the
 * producer, parse and write in small slices in the consumer. Network wait is
 * not CPU time; JSON.parse of a large body IS.
 *
 * If SLICE_SIZE has to drop below ~10 to stay in budget, stop tuning and move
 * to Workers Paid ($5/mo, 30 s CPU default). See README.
 */

import {
  listModels,
  listBenchmarks,
  fetchRankingsDaily,
  isFree,
  baseSlug,
  supportsVision,
  supportsTools,
  type ORModel,
  type BenchmarkItem,
} from './openrouter';
import { observeFields, persistCapabilities } from './capabilities';
import { requireAdmin } from './auth';
import { computeAndStore, answerKey, TIERS, type Tier } from './ranking';
import { recommend, parseRequest } from './recommend';
import { ingestLeaderboard, LEADERBOARD_COUNT } from './terminalbench';
import { syncPool, assignPools, type QuotaPool } from './quota';
import { handleUpdate, verifyWebhook, redeemLinkToken, ensureUser, type TelegramUpdate } from './telegram';
import { maybeAlert } from './alerts';
import { INDEX_HTML, SETTINGS_HTML } from './ui';
import {
  ScraperRegistry,
  createRegistry,
  type Scraper,
  type ScraperMessage,
  type ScraperResult,
  type ScraperEnv,
  // Phase 1
  GroqScraper, TogetherScraper, FireworksScraper, CerebrasScraper, SambaNovaScraper,
  DeepInfraScraper, NovitaScraper, HyperbolicScraper, SiliconFlowScraper, NvidiaNimScraper,
  // Phase 2
  ReplicateScraper, BasetenScraper, ModalScraper, LeptonScraper, OctoAIScraper,
  AnyscaleScraper, RunPodScraper, LambdaScraper, HfInferenceScraper, CloudflareScraper,
  FalScraper, PuterScraper, NebiusScraper, ScalewayScraper, CoreWeaveScraper,
  BeamScraper, VastScraper, CrusoeScraper, InfercomScraper, LyceumScraper,
  BergetScraper, NscaleScraper, OvhcloudScraper, LibertAIScraper, TokenwareScraper,
  IonRouterScraper, FerryAPIScraper, HfHubScraper,
  // Phase 3
  OpenAIScraper, AnthropicScraper, GeminiScraper, LlamaScraper, MistralScraper,
  XAIScraper, CohereScraper, DeepSeekScraper, QwenScraper, MoonshotScraper,
  ZhipuGLMScraper, DoubaoScraper, MiniMaxScraper, ErnieScraper, YiScraper,
  StabilityAIScraper, MidjourneyScraper, HunyuanScraper, NovaScraper, PhiScraper,
  AI21Scraper, PerplexityScraper, StepFunScraper, ZhipuAIScraper,
  // Phase 4
  CursorScraper, WindsurfScraper, CopilotScraper, ClineScraper, AiderScraper,
  ContinueScraper, CodyScraper, TabnineScraper, AmazonQScraper, JetBrainsScraper,
  ReplitScraper, V0Scraper, BoltScraper, LovableScraper, DevinScraper,
  ZedScraper, AugmentScraper, FactoryScraper, KiroScraper, WarpScraper,
  JulesScraper, CodexScraper, VoidScraper,
  // Phase 5
  OpenClawScraper, OpenCodeScraper, HermesScraper, AmpScraper, GooseScraper,
  CrushScraper, CodexAgentScraper, NemoClawScraper, CursorAgentScraper,
  GeminiCLIScraper, GrokBuildScraper,
  // Phase 6
  AWSBedrockScraper, AzureOpenAIScraper, GoogleVertexAIScraper, IBMWatsonxScraper,
  OracleCloudAIScraper, CloudflareAIGatewayScraper, PuterImageScraper, LiteLLMScraper,
  PortkeyScraper, LangSmithScraper, PerplexitySearchScraper, YouComScraper,
  CharacterAIScraper, DoubaoChatScraper, KimiChatScraper, TongyiScraper,
  ERNIEChatScraper, GLMChatScraper, DeepSeekChatScraper, SWEAgentScraper,
  OpenHandsScraper, OnaScraper, NxCodeScraper, MastraScraper,
  CanvaAIScraper, NotionAIScraper, GrammarlyScraper, JasperScraper, LinearScraper,
  RunwayScraper, PikaScraper, KlingAIScraper, LumaScraper, SoraScraper,
  SynthesiaScraper, HeyGenScraper, DIDScraper, SeedanceScraper, ElevenLabsScraper,
  SunoScraper, UdioScraper, StabilityAudioScraper, DescriptScraper,
  MidjourneyImageScraper, DALLEScraper, StableDiffusionScraper, IdeogramScraper,
  LeonardoAIScraper, MagnificScraper, FalImageScraper,
} from './scrapers/registry';

export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  SYNC_QUEUE: Queue<SyncMessage>;
  OPENROUTER_API_KEY: string;
  /** Shared secret for /admin/*. Set via `wrangler secret put ADMIN_SECRET`. */
  ADMIN_SECRET?: string;
  /** Telegram bot token. `wrangler secret put TELEGRAM_BOT_TOKEN` */
  TELEGRAM_BOT_TOKEN?: string;
  /** Echoed by Telegram on every webhook call; proves the update is genuine. */
  TELEGRAM_WEBHOOK_SECRET?: string;
  /** Public origin, used to build magic links. */
  PUBLIC_URL?: string;
  /** Models normalised per queue invocation. Lower if CPU budget is exceeded. */
  SLICE_SIZE?: string;
  /** Scraper registry — built-in scrapers + any dynamically registered ones. */
  registry?: ScraperRegistry;
}

type SyncMessage =
  | { kind: 'models_slice'; runId: string; models: ORModel[]; sliceIndex: number; sliceTotal: number }
  | { kind: 'benchmarks'; runId: string; source: 'artificial-analysis' | 'design-arena'; category?: string }
  | { kind: 'usage'; runId: string }
  | { kind: 'terminalbench'; runId: string; versionIndex: number }
  | { kind: 'quota'; runId: string; poolId: string }
  | { kind: 'rank'; runId: string; category: string; tier: Tier }
  | { kind: 'finalise'; runId: string }
  | { kind: 'tally'; runId: string }
  | { kind: string; runId: string };

type KnownSyncKind = SyncMessage['kind'] extends infer K ? Extract<K, string> : never;

const DEFAULT_SLICE = 25;

/** Create a registry with all built-in scrapers pre-registered. */
function createDefaultRegistry(): ScraperRegistry {
  return createRegistry(
    // Phase 1 — High-value inference
    new GroqScraper(), new TogetherScraper(), new FireworksScraper(),
    new CerebrasScraper(), new SambaNovaScraper(), new DeepInfraScraper(),
    new NovitaScraper(), new HyperbolicScraper(), new SiliconFlowScraper(),
    new NvidiaNimScraper(),
    // Phase 2 — Remaining inference
    new ReplicateScraper(), new BasetenScraper(), new ModalScraper(),
    new LeptonScraper(), new OctoAIScraper(), new AnyscaleScraper(),
    new RunPodScraper(), new LambdaScraper(), new HfInferenceScraper(),
    new CloudflareScraper(), new FalScraper(), new PuterScraper(),
    new NebiusScraper(), new ScalewayScraper(), new CoreWeaveScraper(),
    new BeamScraper(), new VastScraper(), new CrusoeScraper(),
    new InfercomScraper(), new LyceumScraper(), new BergetScraper(),
    new NscaleScraper(), new OvhcloudScraper(), new LibertAIScraper(),
    new TokenwareScraper(), new IonRouterScraper(), new FerryAPIScraper(),
    new HfHubScraper(),
    // Phase 3 — AI labs
    new OpenAIScraper(), new AnthropicScraper(), new GeminiScraper(),
    new LlamaScraper(), new MistralScraper(), new XAIScraper(),
    new CohereScraper(), new DeepSeekScraper(), new QwenScraper(),
    new MoonshotScraper(), new ZhipuGLMScraper(), new DoubaoScraper(),
    new MiniMaxScraper(), new ErnieScraper(), new YiScraper(),
    new StabilityAIScraper(), new MidjourneyScraper(), new HunyuanScraper(),
    new NovaScraper(), new PhiScraper(), new AI21Scraper(),
    new PerplexityScraper(), new StepFunScraper(), new ZhipuAIScraper(),
    // Phase 4 — IDEs and coding tools
    new CursorScraper(), new WindsurfScraper(), new CopilotScraper(),
    new ClineScraper(), new AiderScraper(), new ContinueScraper(),
    new CodyScraper(), new TabnineScraper(), new AmazonQScraper(),
    new JetBrainsScraper(), new ReplitScraper(), new V0Scraper(),
    new BoltScraper(), new LovableScraper(), new DevinScraper(),
    new ZedScraper(), new AugmentScraper(), new FactoryScraper(),
    new KiroScraper(), new WarpScraper(), new JulesScraper(),
    new CodexScraper(), new VoidScraper(),
    // Phase 5 — Agent harnesses
    new OpenClawScraper(), new OpenCodeScraper(), new HermesScraper(),
    new AmpScraper(), new GooseScraper(), new CrushScraper(),
    new CodexAgentScraper(), new NemoClawScraper(), new CursorAgentScraper(),
    new GeminiCLIScraper(), new GrokBuildScraper(),
    // Phase 6 — AI tools & SaaS
    new AWSBedrockScraper(), new AzureOpenAIScraper(), new GoogleVertexAIScraper(),
    new IBMWatsonxScraper(), new OracleCloudAIScraper(), new CloudflareAIGatewayScraper(),
    new PuterImageScraper(), new LiteLLMScraper(), new PortkeyScraper(),
    new LangSmithScraper(), new PerplexitySearchScraper(), new YouComScraper(),
    new CharacterAIScraper(), new DoubaoChatScraper(), new KimiChatScraper(),
    new TongyiScraper(), new ERNIEChatScraper(), new GLMChatScraper(),
    new DeepSeekChatScraper(), new SWEAgentScraper(), new OpenHandsScraper(),
    new OnaScraper(), new NxCodeScraper(), new MastraScraper(),
    new CanvaAIScraper(), new NotionAIScraper(), new GrammarlyScraper(),
    new JasperScraper(), new LinearScraper(), new RunwayScraper(),
    new PikaScraper(), new KlingAIScraper(), new LumaScraper(),
    new SoraScraper(), new SynthesiaScraper(), new HeyGenScraper(),
    new DIDScraper(), new SeedanceScraper(), new ElevenLabsScraper(),
    new SunoScraper(), new UdioScraper(), new StabilityAudioScraper(),
    new DescriptScraper(), new MidjourneyImageScraper(), new DALLEScraper(),
    new StableDiffusionScraper(), new IdeogramScraper(), new LeonardoAIScraper(),
    new MagnificScraper(), new FalImageScraper(),
  );
}

/** Design Arena categories worth ingesting. AA needs no fan-out — one call covers it. */
const DA_CATEGORIES = ['codecategories', 'uicomponent', 'gamedev', 'dataviz', 'svg'];

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export default {
  /** Cron: fetch the catalog, fan it out into slices. Minimal CPU here. */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(startSync(env));
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // ---- public request path: one KV read, no upstream calls --------------
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(INDEX_HTML, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'public, max-age=300',
        },
      });
    }

    // Preferences live in a cookie, not a server-side user store — the request
    // path must not touch D1. `/settings` is the only writer.
    if (url.pathname === '/settings') {
      if (req.method === 'POST') {
        const form = await req.formData();
        const flags = {
          openrouter_paid_credits: form.get('openrouter_paid_credits') === 'on',
        };
        const tier = form.get('default_tier') === 'all' ? 'all' : 'free';
        const size = ['small', 'medium', 'large', 'agent'].includes(String(form.get('default_size')))
          ? String(form.get('default_size'))
          : 'medium';
        const quality = form.get('default_quality') === 'share' ? 'share' : 'benchmark';
        const value = encodeURIComponent(
          `openrouter_paid_credits=${flags.openrouter_paid_credits ? '1' : '0'}&default_tier=${tier}&default_size=${size}&default_quality=${quality}`,
        );
        return new Response(null, {
          status: 303,
          headers: {
            location: '/settings?saved=1',
            'set-cookie': `mm_prefs=${value}; Max-Age=${365 * 24 * 3600}; Path=/; SameSite=Lax; Secure`,
          },
        });
      }
      if (url.searchParams.get('clear') === '1') {
        return new Response(null, {
          status: 303,
          headers: {
            location: '/settings',
            'set-cookie': 'mm_prefs=; Max-Age=0; Path=/; SameSite=Lax; Secure',
          },
        });
      }
      return new Response(SETTINGS_HTML, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' },
      });
    }

    // Telegram webhook. Authenticated by the secret token Telegram echoes,
    // not by obscurity of the path.
    if (url.pathname === '/telegram/webhook' && req.method === 'POST') {
      if (!verifyWebhook(req, env.TELEGRAM_WEBHOOK_SECRET)) {
        return new Response('forbidden', { status: 403 });
      }
      const update = (await req.json()) as TelegramUpdate;
      // Always 200 to Telegram: a non-200 makes it retry the same update
      // indefinitely. Failures are logged, not surfaced upstream.
      try {
        await handleUpdate(update, env);
      } catch (err) {
        console.error('telegram update failed', err);
      }
      return new Response('ok');
    }

    // Magic-link redemption: binds this browser to the Telegram identity.
    if (url.pathname === '/link') {
      const token = url.searchParams.get('t') ?? '';
      const userId = await redeemLinkToken(env.DB, token);
      if (!userId) {
        return new Response('This link is invalid, expired, or already used.', { status: 400 });
      }
      await ensureUser(env.DB, userId);
      return new Response(null, {
        status: 302,
        headers: {
          location: '/',
          // Host-only, HTTP-only, strict: this cookie is the browser's proof of
          // identity and must not be readable by scripts or sent cross-site.
          'set-cookie': `mm_user=${encodeURIComponent(userId)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=31536000`,
        },
      });
    }

    if (url.pathname === '/api/recommend') {
      const parsed = parseRequest(url);
      if (!parsed.task.trim()) {
        return Response.json({ error: 'task_required' }, { status: 400 });
      }
      const result = await recommend(env.CACHE, parsed, readPrefs(req));
      return Response.json(result, {
        headers: { 'cache-control': 'public, max-age=60' },
      });
    }

    if (url.pathname === '/health') {
      const run = await env.DB.prepare(
        `SELECT run_id, started_at, finished_at, status, slices_total, slices_done, note
           FROM sync_runs ORDER BY started_at DESC LIMIT 1`,
      ).first();
      return Response.json({ ok: true, last_run: run ?? null });
    }

    // ---- everything below requires the admin secret -----------------------
    if (url.pathname.startsWith('/admin/')) {
      const auth = requireAdmin(req, env.ADMIN_SECRET);
      if (!auth.ok) return auth.response;
    }

    // Manual trigger — a plain POST from any phone HTTP client starts a run.
    if (url.pathname === '/admin/sync' && req.method === 'POST') {
      try {
        const runId = await startSync(env);
        return Response.json({ started: runId });
      } catch (e) {
        return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
      }
    }

    // Manual scraper trigger — runs all scrapers (or a subset via ?scrapers=id1,id2).
    if (url.pathname === '/admin/scrape' && req.method === 'POST') {
      try {
        const runId = crypto.randomUUID();
        const registry = env.registry ?? createDefaultRegistry();
        const allMessages = registry.planMessages(runId);
        // Optional: filter to specific scrapers via ?scrapers=groq,together
        const filterParam = url.searchParams.get('scrapers');
        const messages = filterParam
          ? allMessages.filter((m) => filterParam.split(',').includes(m.kind))
          : allMessages;
        // Enqueue in batches of 50.
        const SCRAPER_BATCH = 50;
        for (let i = 0; i < messages.length; i += SCRAPER_BATCH) {
          const batch = messages.slice(i, i + SCRAPER_BATCH);
          await env.SYNC_QUEUE.sendBatch(batch.map((body) => ({ body })));
        }
        return Response.json({
          started: runId,
          scrapers: registry.size,
          messages_enqueued: messages.length,
          filter: filterParam ?? 'all',
        });
      } catch (e) {
        return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
      }
    }

    // What did the credentials actually return? Answers "what can my key see"
    // without ever needing a terminal.
    if (url.pathname === '/admin/capabilities') {
      const { results } = await env.DB.prepare(
        `SELECT source, field_path, available, tier_reported, observed_at
           FROM source_capabilities ORDER BY source, field_path`,
      ).all();
      return Response.json({ capabilities: results });
    }

    // Terminal-Bench ingestion report: match rate and unmatched names.
    if (url.pathname === '/admin/terminalbench') {
      const reports = await Promise.all(
        ['2.0', '2.1'].map(async (v) => JSON.parse((await env.CACHE.get(`tb-report:${v}`)) ?? 'null')),
      );
      return Response.json({ reports: reports.filter(Boolean) });
    }

    // Quota pool state: value, source method, and whether sources disagreed.
    if (url.pathname === '/admin/quota') {
      const { results } = await env.DB.prepare(
        `SELECT pool_id, platform, label, quota_unit, quota_value, conditional_value,
                condition_note, is_shared, confidence, last_verified_at, notes
           FROM quota_pools ORDER BY pool_id`,
      ).all();
      return Response.json({ pools: results });
    }

    // Scraper health: status of all registered scrapers.
    if (url.pathname === '/admin/sources') {
      // From D1 scraper_health table.
      const { results: dbHealth } = await env.DB.prepare(
        `SELECT scraper_id, last_run_at, last_status, last_error,
                consecutive_failures, models_found, scores_written
           FROM scraper_health ORDER BY scraper_id`,
      ).all();
      // From in-memory registry (for scrapers not yet writing to D1).
      const registry = env.registry ?? createDefaultRegistry();
      const registryHealth = registry.healthAll();
      return Response.json({ db: dbHealth, registry: registryHealth, count: registry.size });
    }

    // Scrape status summary — quick overview of scraper health.
    if (url.pathname === '/admin/scrape/status') {
      const { results } = await env.DB.prepare(
        `SELECT last_status, COUNT(*) as count FROM scraper_health GROUP BY last_status`,
      ).all();
      const total = await env.DB.prepare(`SELECT COUNT(*) as count FROM scraper_health`).first();
      const offerings = await env.DB.prepare(`SELECT COUNT(*) as count FROM offerings`).first();
      return Response.json({
        scrapers: { total: total?.count ?? 0, by_status: results },
        offerings: offerings?.count ?? 0,
      });
    }

    // Inspect a computed answer blob without going through the UI.
    if (url.pathname === '/admin/answer') {
      const category = url.searchParams.get('category') ?? 'coding';
      const tier = (url.searchParams.get('tier') ?? 'free') as Tier;
      const blob = await env.CACHE.get(answerKey(category, tier));
      return blob
        ? new Response(blob, { headers: { 'content-type': 'application/json' } })
        : Response.json({ error: 'not_computed', category, tier }, { status: 404 });
    }

    return new Response('not found', { status: 404 });
  },

  /** Queue consumer. One bounded slice per message. */
  async queue(batch: MessageBatch<SyncMessage>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      try {
        await handleMessage(msg.body, env);
        msg.ack();
      } catch (err) {
        console.error('slice failed', msg.body.kind, err);
        msg.retry();
      }
    }
  },
};

// ---------------------------------------------------------------------------
// Producer
// ---------------------------------------------------------------------------

async function startSync(env: Env): Promise<string> {
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();

  const catalog = await listModels(env.OPENROUTER_API_KEY);
  const models = catalog.data ?? [];

  const sliceSize = Number(env.SLICE_SIZE ?? DEFAULT_SLICE);
  const slices: ORModel[][] = [];
  for (let i = 0; i < models.length; i += sliceSize) {
    slices.push(models.slice(i, i + sliceSize));
  }

  const benchmarkJobs: SyncMessage[] = [
    { kind: 'benchmarks', runId, source: 'artificial-analysis' },
    ...DA_CATEGORIES.map(
      (category): SyncMessage => ({ kind: 'benchmarks', runId, source: 'design-arena', category }),
    ),
    // Community usage (share-of-spend) — the alternative quality source.
    // One dataset call; lands before ranking like the benchmark ingests.
    { kind: 'usage', runId },
    // Terminal-Bench moves slowly, but it is cheap (2 plain fetches) and must
    // land before ranking, since H feeds the composite.
    ...Array.from({ length: LEADERBOARD_COUNT }, (_, i): SyncMessage => ({
      kind: 'terminalbench', runId, versionIndex: i,
    })),
  ];

  const sliceTotal = slices.length + benchmarkJobs.length;

  await env.DB.prepare(
    `UPDATE sync_runs SET status = 'failed', finished_at = ?1, note = 'superseded'
      WHERE status = 'running'`,
  ).bind(startedAt).run();

  await env.DB.prepare(
    `INSERT INTO sync_runs (run_id, started_at, status, slices_total, slices_done)
     VALUES (?1, ?2, 'running', ?3, 0)`,
  )
    .bind(runId, startedAt, sliceTotal)
    .run();

  // One send per slice: a whole-catalog batch can exceed the 256KB
  // sendBatch limit (337 models ≈ 530KB).
  for (const [i, slice] of slices.entries()) {
    await env.SYNC_QUEUE.send(
      { kind: 'models_slice', runId, models: slice, sliceIndex: i, sliceTotal: slices.length } as SyncMessage,
    );
  }
  await env.SYNC_QUEUE.sendBatch(benchmarkJobs.map((body) => ({ body })));

  // --- Universal Scraper Network: fan out one message per scraper ---
  const registry = env.registry ?? createDefaultRegistry();
  const scraperMessages = registry.planMessages(runId);
  // Send in batches of 50 to stay under the 256KB sendBatch limit.
  const SCRAPER_BATCH = 50;
  for (let i = 0; i < scraperMessages.length; i += SCRAPER_BATCH) {
    const batch = scraperMessages.slice(i, i + SCRAPER_BATCH);
    await env.SYNC_QUEUE.sendBatch(batch.map((body) => ({ body })));
  }
  console.log(`scrapers: ${scraperMessages.length} messages enqueued from ${registry.size} scrapers`);

  // Rank compute is delayed so ingestion has landed first. One message per
  // (category, tier) pair keeps each invocation's CPU bounded.
  await env.SYNC_QUEUE.send({ kind: 'finalise', runId }, { delaySeconds: 90 });

  return runId;
}

// ---------------------------------------------------------------------------
// Consumer
// ---------------------------------------------------------------------------

async function handleMessage(msg: SyncMessage, env: Env): Promise<void> {
  // Check the registry first — new scrapers register here.
  // Scraper messages have kinds like 'groq', 'together', etc. — not in the
  // built-in union, so we try the registry before the switch.
  const registry = env.registry ?? createDefaultRegistry();
  if (registry.canHandle(msg.kind)) {
    const scraperEnv: ScraperEnv = { DB: env.DB, CACHE: env.CACHE };
    const result = await registry.handle(
      { kind: msg.kind, runId: msg.runId, payload: msg } as ScraperMessage,
      scraperEnv,
    );
    console.log(`registry ${msg.kind}: ${result.offerings} offerings, ${result.scores} scores`);
    await bumpProgress(msg.runId, env);
    return;
  }

  // Fall back to built-in handlers for backward compatibility.
  switch (msg.kind) {
    case 'models_slice':
      return ingestModelSlice((msg as { models: ORModel[] }).models, msg.runId, env);
    case 'benchmarks': {
      const b = msg as { source: 'artificial-analysis' | 'design-arena'; category?: string };
      return ingestBenchmarks(b.source, b.category, msg.runId, env);
    }
    case 'usage':
      return ingestUsage(msg.runId, env);
    case 'terminalbench':
      return ingestTerminalBench((msg as { versionIndex: number }).versionIndex, msg.runId, env);
    case 'quota':
      return syncQuotaPool((msg as { poolId: string }).poolId, msg.runId, env);
    case 'rank': {
      const r = msg as { category: string; tier: Tier };
      return rankSlice(r.category, r.tier, msg.runId, env);
    }
    case 'finalise':
      return finalise(msg.runId, env);
    case 'tally':
      return tally(msg.runId, env);
  }
}

/**
 * Normalise one slice of the catalog into `offerings`.
 *
 * Harness/plan assignment at this stage is deliberately coarse: everything the
 * OpenRouter API exposes is recorded as the `openrouter-api` harness. Real
 * harness rows (opencode-cli, claude-web, cursor, ...) are populated by the
 * step-7 quota scraper, which knows which models each surface actually serves.
 */
async function ingestModelSlice(models: ORModel[], runId: string, env: Env): Promise<void> {
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
    const free = isFree(m);
    return stmt.bind(
      m.id,
      'openrouter-api',
      free ? 'free' : 'paid',
      'api',
      m.context_length ?? null,
      supportsVision(m) ? 1 : 0,
      supportsTools(m) ? 1 : 0,
      free ? 1 : 0,
      Number(m.pricing?.prompt ?? 0),
      Number(m.pricing?.completion ?? 0),
      `https://openrouter.ai/${m.id}`,
      now,
      // The benchmark/usage join key: strip the `:variant` suffix.
      baseSlug(m.id),
    );
  });

  await env.DB.batch(rows);

  // Record catalog capabilities once per run, from the first slice only.
  if (models.length > 0) {
    await persistCapabilities(
      env.DB,
      observeFields('openrouter-models', models[0] as unknown as Record<string, unknown>),
      now,
    );
  }

  await bumpProgress(runId, env);
}

async function ingestBenchmarks(
  source: 'artificial-analysis' | 'design-arena',
  category: string | undefined,
  runId: string,
  env: Env,
): Promise<void> {
  const res = await listBenchmarks(env.OPENROUTER_API_KEY, { source, category });
  const asOf = res.meta?.as_of ?? new Date().toISOString();
  const items = res.data ?? [];

  // Store the upstream-supplied attribution string verbatim rather than
  // hardcoding our own wording.
  if (res.meta?.citation) {
    await env.CACHE.put(`citation:${source}`, res.meta.citation);
  }

  const stmt = env.DB.prepare(
    `INSERT INTO scores (model_id, harness_id, benchmark, value, score_scope, source, as_of, score_key)
     VALUES (?1, '', ?2, ?3, 'model_only_inferred', ?4, ?5, ?6)
     ON CONFLICT(model_id, harness_id, benchmark) DO UPDATE SET
       value = excluded.value,
       as_of = excluded.as_of,
       score_key = excluded.score_key`,
  );

  const rows = [];
  for (const item of items as BenchmarkItem[]) {
    const key = baseSlug(item.model_permaslug);
    if (item.source === 'artificial-analysis') {
      const pairs: Array<[string, number | null]> = [
        ['aa_intelligence_index', item.intelligence_index ?? null],
        ['aa_coding_index', item.coding_index ?? null],
        ['aa_agentic_index', item.agentic_index ?? null],
      ];
      for (const [name, value] of pairs) {
        if (value !== null && value !== undefined) {
          rows.push(stmt.bind(item.model_permaslug, name, value, source, asOf, key));
        }
      }
    } else {
      rows.push(
        stmt.bind(item.model_permaslug, `da_${item.category}_elo`, item.elo, source, asOf, key),
      );
    }
  }

  if (rows.length > 0) await env.DB.batch(rows);

  if (items.length > 0) {
    await persistCapabilities(
      env.DB,
      observeFields(source, items[0] as unknown as Record<string, unknown>, '', res.meta?.version ?? null),
      asOf,
    );
  }

  await bumpProgress(runId, env);
}

/**
 * Community usage: trailing-window token totals per model, the dataset behind
 * the openrouter.ai/rankings "share of spend" view.
 *
 * Stored per (date, model_permaslug) so re-runs are idempotent; the rank query
 * sums the window. The reserved `other` row (the long tail) is skipped — it is
 * a denominator, never an offering. Free variants get their OWN rows, so a
 * free model's usage is not silently attributed to the paid tier.
 */
async function ingestUsage(runId: string, env: Env): Promise<void> {
  // The dataset's default window is 30 days; we want the trailing 7 days the
  // rankings page shows. end_date is the most recent COMPLETED UTC day — the
  // in-progress day is partial and would skew the share.
  const end = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  const start = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  const res = await fetchRankingsDaily(env.OPENROUTER_API_KEY, { startDate: start, endDate: end });

  const asOf = res.meta?.as_of ?? new Date().toISOString();
  // Required attribution verbatim: the dataset must be cited as
  // "Source: OpenRouter (openrouter.ai/rankings), as of {as_of}."
  await env.CACHE.put(`citation:rankings-daily`, `Source: OpenRouter (openrouter.ai/rankings), as of ${asOf}.`);
  await env.CACHE.put(`usage-as-of`, asOf);

  const stmt = env.DB.prepare(
    `INSERT INTO usage_rankings (date, model_permaslug, score_key, total_tokens)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(date, model_permaslug) DO UPDATE SET
       total_tokens = excluded.total_tokens`,
  );

  const rows = (res.data ?? []).map((item) =>
    item.model_permaslug === 'other'
      ? null
      : stmt.bind(item.date, item.model_permaslug, baseSlug(item.model_permaslug), Number(item.total_tokens)),
  ).filter((r): r is NonNullable<typeof r> => r !== null);

  if (rows.length > 0) await env.DB.batch(rows);
  console.log(`usage ${start}..${end}: ${rows.length} rows (${res.data?.length ?? 0} returned)`);

  await bumpProgress(runId, env);
}

/**
 * Terminal-Bench: the only public source that scores a model AND its harness
 * together. Costs zero Browser Rendering time — the leaderboard is
 * server-rendered, so a plain fetch() gets all ~142 entries.
 *
 * Errors propagate so the message retries and the run is marked partial.
 * Existing harness scores are left alone, which means the board keeps serving
 * the last good data instead of silently losing its harness deltas.
 */
async function ingestTerminalBench(versionIndex: number, runId: string, env: Env): Promise<void> {
  const report = await ingestLeaderboard(env.DB, versionIndex);
  console.log(
    `terminal-bench ${report.version}: ${report.fetched} fetched, ` +
    `${report.attributable} attributable, ${report.matched} matched, ` +
    `${report.harnessRows} harness rows`,
  );
  if (report.unmatched.length > 0) {
    // Visible, not fatal. Unmatched names are usually models absent from
    // OpenRouter's catalog, which is legitimate — but a sudden jump means the
    // matcher regressed.
    console.log(`terminal-bench ${report.version}: unmatched -> ${report.unmatched.join(', ')}`);
  }
  await env.CACHE.put(`tb-report:${report.version}`, JSON.stringify(report));
  await bumpProgress(runId, env);
}

/**
 * Refresh one quota pool.
 *
 * OpenRouter's pool is read LIVE from GET /api/v1/key, which reports the
 * account's actual tier rather than the documented default. Others fall back to
 * a plain fetch of the provider's rate-limit page. Neither path uses Browser
 * Rendering, so the 10 min/day allowance is untouched.
 */
async function syncQuotaPool(poolId: string, runId: string, env: Env): Promise<void> {
  const pool = await env.DB.prepare(`SELECT * FROM quota_pools WHERE pool_id = ?1`)
    .bind(poolId)
    .first<QuotaPool>();

  if (pool) {
    const report = await syncPool(env.DB, pool, env);
    console.log(
      `quota ${report.poolId}: ${report.method} -> ${report.value} ${report.unit} ` +
      `(${report.confidence})${report.disagreement ? ' [sources disagree]' : ''}`,
    );
    await env.CACHE.put(`quota-report:${poolId}`, JSON.stringify(report));
  }

  await bumpProgress(runId, env);
}

/** One (category, tier) pair per invocation. Writes exactly one KV key. */
async function rankSlice(category: string, tier: Tier, runId: string, env: Env): Promise<void> {
  try {
    const result = await computeAndStore(env.DB, env.CACHE, category, tier);

    if (result && result.count > 0) {
      const alerted = await maybeAlert(env, category, tier);
      if (alerted.sent > 0 || alerted.suppressed.length > 0) {
        console.log(
          `alerts [${category}/${tier}]: ${alerted.sent} sent` +
          (alerted.suppressed.length ? `, suppressed ${alerted.suppressed.join('; ')}` : ''),
        );
      }
    }

    await bumpProgress(runId, env);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await env.DB.prepare(
      `UPDATE sync_runs SET note = ?2 WHERE run_id = ?1 AND (note IS NULL OR note NOT LIKE 'rank %')`,
    ).bind(runId, `rank ${category}/${tier}: ${msg}`).run();
    throw e;
  }
}

/**
 * Ingestion is done: fan out rank computation, then close the run.
 *
 * Categories are read from D1 rather than hardcoded, so adding a row to
 * category_benchmarks is enough to add a category — no code change.
 */
async function finalise(runId: string, env: Env): Promise<void> {
  const { results } = await env.DB.prepare(`SELECT category FROM category_benchmarks`).all<{
    category: string;
  }>();
  const categories = (results ?? []).map((r) => r.category);

  // Attach free API offerings to the shared OpenRouter pool before ranking, so
  // the K term has a value to read.
  await assignPools(env.DB);

  const { results: pools } = await env.DB.prepare(`SELECT pool_id FROM quota_pools`).all<{
    pool_id: string;
  }>();

  const rankJobs: SyncMessage[] = (pools ?? []).map(
    (p): SyncMessage => ({ kind: 'quota', runId, poolId: p.pool_id }),
  );

  for (const category of categories) {
    for (const tier of TIERS) {
      rankJobs.push({ kind: 'rank', runId, category, tier });
    }
  }

  if (rankJobs.length > 0) {
    await env.DB.prepare(
      `UPDATE sync_runs SET slices_total = slices_total + ?2 WHERE run_id = ?1`,
    )
      .bind(runId, rankJobs.length)
      .run();
    await env.SYNC_QUEUE.sendBatch(rankJobs.map((body) => ({ body })));
  }

  // The run stays 'running' until every slice (including the rank jobs just
  // enqueued) has bumped; the tally below marks it finished if anything died.
  await env.SYNC_QUEUE.send({ kind: 'tally', runId }, { delaySeconds: 60 });
}

/** Late check: close the run — 'ok' if everything landed, otherwise 'partial'. */
async function tally(runId: string, env: Env): Promise<void> {
  const run = await env.DB.prepare(
    `SELECT slices_total, slices_done, status FROM sync_runs WHERE run_id = ?1`,
  )
    .bind(runId)
    .first<{ slices_total: number; slices_done: number; status: string }>();
  if (!run || run.status !== 'running') return;

  if (run.slices_done >= run.slices_total) {
    await env.DB.prepare(
      `UPDATE sync_runs SET finished_at = ?2, status = 'ok', note = NULL WHERE run_id = ?1`,
    )
      .bind(runId, new Date().toISOString())
      .run();
  } else {
    await env.DB.prepare(
      `UPDATE sync_runs SET finished_at = ?2, status = 'partial', note = ?3 WHERE run_id = ?1`,
    )
      .bind(runId, new Date().toISOString(), `${run.slices_done}/${run.slices_total} slices landed`)
      .run();
  }
}

async function bumpProgress(runId: string, env: Env): Promise<void> {
  // Never marks the run finished: finalise may still add rank jobs to the
  // total (it is sent with a 90s delay). tally() is the only place that
  // closes a run.
  await env.DB.prepare(`UPDATE sync_runs SET slices_done = slices_done + 1 WHERE run_id = ?1`)
    .bind(runId)
    .run();
}

/** Parse the mm_prefs cookie into the boolean flags /api/recommend consumes. */
function readPrefs(req: Request): Record<string, boolean> {
  const m = /(?:^|;\s*)mm_prefs=([^;]+)/.exec(req.headers.get('cookie') ?? '');
  if (!m) return {};
  const flags: Record<string, boolean> = {};
  for (const pair of decodeURIComponent(m[1]).split('&')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    if (pair.slice(eq + 1) === '1') flags[pair.slice(0, eq)] = true;
  }
  return flags;
}
