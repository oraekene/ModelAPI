/**
 * awesome-free-ai-coding index.json -> offerings rows.
 *
 * The repo probes every free offer twice a week and publishes index.json with
 * per-entry evidence (source URLs, probe config, last_verified). Only two
 * fields matter here: `api.model_ids` (exact free API model ids, e.g.
 * "nvidia/nemotron-3-ultra-550b-a55b:free") and, when a provider has no API
 * list, `models[].aa_model` / `models[].family` (family-level names).
 *
 * Archived entries (retired upstream) are skipped. Everything is free: that is
 * the whole point of the source.
 */
import { BaseScraper } from './base';
import type { ScraperMessage, ScraperResult, ScraperEnv } from './types';
import { offeringStatements, type CrawledModel } from './web-crawler';

export const INDEX_URL =
  'https://raw.githubusercontent.com/mvalentsev/awesome-free-ai-coding/main/index.json';
const BATCH_SIZE = 50;

export interface AfacEntry {
  id?: string;
  name?: string;
  url?: string;
  archived?: boolean;
  api?: { base_url?: string; openai_compatible?: boolean; model_ids?: unknown };
  models?: Array<{ family?: string; aa_model?: string }>;
}

/** One offering row per free model id; exact API ids win over family names. */
export function mapEntriesToModels(entries: AfacEntry[]): CrawledModel[] {
  const out: CrawledModel[] = [];
  for (const e of entries) {
    if (e.archived || typeof e.id !== 'string' || !e.id || typeof e.url !== 'string' || !e.url) {
      continue;
    }
    const apiIds = Array.isArray(e.api?.model_ids)
      ? e.api.model_ids.filter((m): m is string => typeof m === 'string' && m.trim() !== '')
      : [];
    const families = (e.models ?? [])
      .map((m) => (typeof m.aa_model === 'string' && m.aa_model ? m.aa_model : m.family))
      .filter((m): m is string => typeof m === 'string' && m.trim() !== '');
    const ids = [...new Set((apiIds.length > 0 ? apiIds : families).map((m) => m.trim()))];

    for (const id of ids) {
      // ":free" is a routing suffix, not part of the model identity.
      const scoreKey = id.split('/').pop()?.replace(/:free$/, '') ?? id;
      out.push({
        modelId: `${e.id}/${id}`,
        harnessId: 'awesome-free-ai-coding',
        planId: 'free',
        medium: 'inference',
        contextWindow: null,
        supportsVision: 0,
        supportsTools: 0,
        isFree: 1,
        pricePrompt: 0,
        priceCompletion: 0,
        accessUrl: e.api?.base_url ?? e.url,
        scoreKey,
      });
    }
  }
  return out;
}

export class AwesomeFreeAiCodingCrawler extends BaseScraper {
  readonly id = 'awesome-free-ai-coding';
  readonly category = 'inference' as const;
  readonly displayName = 'awesome-free-ai-coding (free offers)';

  protected async doHandle(_msg: ScraperMessage, env: ScraperEnv): Promise<ScraperResult> {
    const res = await fetch(INDEX_URL, { headers: { 'User-Agent': 'ModelMapBot/1.0' } });
    if (!res.ok) throw new Error(`awesome-free-ai-coding index HTTP ${res.status}`);
    const index = (await res.json()) as { entries?: unknown };
    if (!Array.isArray(index.entries) || index.entries.length === 0) {
      throw new Error('awesome-free-ai-coding index has no entries — format changed');
    }

    const models = mapEntriesToModels(index.entries as AfacEntry[]);
    const statements = offeringStatements(env, models, new Date().toISOString());
    for (let i = 0; i < statements.length; i += BATCH_SIZE) {
      await env.DB.batch(statements.slice(i, i + BATCH_SIZE));
    }
    return {
      offerings: models.length,
      scores: 0,
      quotas: 0,
      note: `${models.length} free models from ${index.entries.length} offers`,
    };
  }
}
