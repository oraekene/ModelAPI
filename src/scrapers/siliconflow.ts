/**
 * SiliconFlow scraper — fetches model catalog from SiliconFlow API.
 *
 * SiliconFlow offers inference with 200+ free models and paid tiers.
 *
 * API docs: https://docs.siliconflow.cn/api-reference/models
 */

import { BaseScraper } from './base';
import type { ScraperMessage, ScraperResult, ScraperEnv } from './types';

export interface SiliconFlowModel {
  id: string;
  object?: string;
  created?: number | null;
  owned_by?: string | null;
  context_length?: number | null;
  pricing?: {
    prompt?: string | number | null;
    completion?: string | number | null;
  } | null;
  [key: string]: unknown;
}

export interface SiliconFlowModelsResponse {
  object?: string;
  data: SiliconFlowModel[];
}

const SILICONFLOW_API = 'https://api.siliconflow.cn/v1';

export class SiliconFlowScraper extends BaseScraper {
  readonly id = 'siliconflow';
  readonly category = 'inference' as const;
  readonly displayName = 'SiliconFlow';

  protected async doHandle(
    _msg: ScraperMessage,
    env: ScraperEnv,
  ): Promise<ScraperResult> {
    const apiKey = env.SILICONFLOW_API_KEY as string | undefined;
    if (!apiKey) throw new Error('SILICONFLOW_API_KEY not set');

    const res = await fetch(`${SILICONFLOW_API}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`siliconflow /models: HTTP ${res.status}`);
    const catalog = (await res.json()) as SiliconFlowModelsResponse;
    const models = catalog.data ?? [];

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
      const id = `siliconflow/${m.id}`;
      const pricePrompt = Number(m.pricing?.prompt ?? 0);
      const priceCompletion = Number(m.pricing?.completion ?? 0);
      const isFree = pricePrompt === 0 && priceCompletion === 0;

      return stmt.bind(
        id,
        'siliconflow-api',
        isFree ? 'free' : 'paid',
        'api',
        m.context_length ?? null,
        0,
        0,
        isFree ? 1 : 0,
        pricePrompt,
        priceCompletion,
        `https://api.siliconflow.cn/v1/models/${m.id}`,
        now,
        m.id,
      );
    });

    if (rows.length > 0) await env.DB.batch(rows);

    await env.DB.prepare(
      `INSERT INTO quota_pools (pool_id, platform, label, quota_unit, quota_value, confidence, last_verified_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(pool_id) DO UPDATE SET
         quota_value = excluded.quota_value,
         last_verified_at = excluded.last_verified_at`,
    )
      .bind('siliconflow-free-tier', 'siliconflow', 'SiliconFlow Free Tier', 'models', 200, 'documented', now)
      .run();

    return { offerings: rows.length, scores: 0, quotas: 1, note: `${rows.length} models from SiliconFlow API` };
  }
}
