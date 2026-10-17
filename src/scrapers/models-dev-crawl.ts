/** models.dev catalog -> offerings rows. */
import { BaseScraper } from './base';
import type { ScraperMessage, ScraperResult, ScraperEnv } from './types';
import { offeringStatements, type CrawledModel } from './web-crawler';

/**
 * Committed slices produced by scripts/build-models-dev-slices.mjs and refreshed
 * twice weekly by .github/workflows/refresh-sources.yml. The repo is public, so
 * the Worker reads them straight from raw.githubusercontent.com.
 */
export const RAW_BASE = 'https://raw.githubusercontent.com/oraekene/ModelAPI/master/data/models-dev';
const BATCH_SIZE = 50;

interface ModelsDevCost {
  input?: number;
  output?: number;
  cache_read?: number;
}

interface ModelsDevModel {
  cost?: ModelsDevCost;
  limit?: { context?: number; output?: number };
  modalities?: { input?: string[]; output?: string[] };
  tool_call?: boolean;
}

interface ModelsDevProvider {
  name?: string;
  doc?: string;
  models?: Record<string, ModelsDevModel>;
}

export type ModelsDevSlice = Record<string, ModelsDevProvider>;

/**
 * models.dev prices are USD per 1M tokens; offerings store USD per token.
 * Only models with a cost object get prices; the rest stay null (unknown, not free).
 */
export function mapSliceToModels(slice: ModelsDevSlice): CrawledModel[] {
  const out: CrawledModel[] = [];
  for (const [providerId, provider] of Object.entries(slice)) {
    for (const [modelId, m] of Object.entries(provider.models ?? {})) {
      const cost = m.cost;
      const perMillion = (v: number | undefined) => (typeof v === 'number' ? v / 1e6 : null);
      const pricePrompt = perMillion(cost?.input);
      const priceCompletion = perMillion(cost?.output);
      const isFree = pricePrompt === 0 && priceCompletion === 0 ? 1 : 0;
      out.push({
        modelId: `${providerId}/${modelId}`,
        harnessId: 'models-dev-crawl',
        planId: isFree ? 'free' : 'paid',
        medium: 'inference',
        contextWindow: typeof m.limit?.context === 'number' ? m.limit.context : null,
        supportsVision: m.modalities?.input?.includes('image') ? 1 : 0,
        supportsTools: m.tool_call ? 1 : 0,
        isFree,
        pricePrompt,
        priceCompletion,
        priceCacheRead: perMillion(cost?.cache_read),
        accessUrl: provider.doc ?? `https://models.dev/?provider=${providerId}`,
        // models.dev keys like "deepseek/deepseek-chat": the bare model slug is
        // the last segment, which is what benchmarks join on.
        scoreKey: modelId.split('/').pop() ?? modelId,
      });
    }
  }
  return out;
}

export class ModelsDevCrawler extends BaseScraper {
  readonly id = 'models-dev-crawl';
  readonly category = 'inference' as const;
  readonly displayName = 'models.dev (sliced catalog)';

  /**
   * Two-stage fan-out: the first message carries no sliceFile, fetches the
   * index and enqueues one message per slice. Processing a single slice per
   * invocation keeps JSON.parse well inside the Worker CPU budget, which the
   * full 5.6 MB api.json would not.
   */
  protected async doHandle(msg: ScraperMessage, env: ScraperEnv): Promise<ScraperResult> {
    // The registry dispatcher wraps the whole queue message as `payload`
    // (src/index.ts: { kind, runId, payload: msg }), so the fields we sent sit
    // one level deeper. Read both shapes defensively.
    const outer = msg.payload as { payload?: { sliceFile?: unknown }; sliceFile?: unknown } | undefined;
    const sliceFile =
      typeof outer?.payload?.sliceFile === 'string'
        ? outer.payload.sliceFile
        : typeof outer?.sliceFile === 'string'
          ? outer.sliceFile
          : null;

    if (sliceFile) return this.ingestSlice(sliceFile, env);
    // No sliceFile = the fan-out message. Refuse to fan out for any other
    // message shape: re-enqueueing on an unexpected payload would loop forever.
    const innerEmpty = !outer?.payload || Object.keys(outer.payload).length === 0;
    if (!innerEmpty) throw new Error(`models-dev-crawl: message has neither sliceFile nor empty payload: ${JSON.stringify(msg.payload).slice(0, 200)}`);
    return this.enqueueSlices(msg.runId, env);
  }

  private async enqueueSlices(runId: string, env: ScraperEnv): Promise<ScraperResult> {
    const res = await fetch(`${RAW_BASE}/index.json`, { headers: { 'User-Agent': 'ModelMapBot/1.0' } });
    if (!res.ok) throw new Error(`models.dev index HTTP ${res.status}`);
    const index = (await res.json()) as { slices?: Array<{ file?: unknown }> };
    const files = (index.slices ?? [])
      .map((s) => s.file)
      .filter((f): f is string => typeof f === 'string');
    if (files.length === 0) throw new Error('models.dev index lists no slices');

    const queue = env.SYNC_QUEUE as { sendBatch(m: Array<{ body: ScraperMessage }>): Promise<unknown> } | undefined;
    if (!queue) throw new Error('SYNC_QUEUE binding missing');
    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      const batch = files
        .slice(i, i + BATCH_SIZE)
        .map((sliceFile) => ({ body: { kind: this.id, runId, payload: { sliceFile } } }));
      await queue.sendBatch(batch);
    }
    return { offerings: 0, scores: 0, quotas: 0, note: `enqueued ${files.length} models.dev slices` };
  }

  private async ingestSlice(sliceFile: string, env: ScraperEnv): Promise<ScraperResult> {
    const res = await fetch(`${RAW_BASE}/${sliceFile}`, { headers: { 'User-Agent': 'ModelMapBot/1.0' } });
    if (!res.ok) throw new Error(`models.dev ${sliceFile} HTTP ${res.status}`);
    const slice = (await res.json()) as ModelsDevSlice;
    const models = mapSliceToModels(slice);
    const statements = offeringStatements(env, models, new Date().toISOString());
    for (let i = 0; i < statements.length; i += BATCH_SIZE) {
      await env.DB.batch(statements.slice(i, i + BATCH_SIZE));
    }
    return { offerings: models.length, scores: 0, quotas: 0, note: `${models.length} models from ${sliceFile}` };
  }
}
