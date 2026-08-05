/**
 * SambaNova scraper — fetches model catalog from SambaNova API.
 *
 * SambaNova offers inference with a free tier for registered users.
 *
 * API docs: https://docs.sambanova.ai/reference/models
 */

import { BaseScraper } from './base';
import type { ScraperMessage, ScraperResult, ScraperEnv } from './types';

export interface SambaModel {
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

export interface SambaModelsResponse {
  object?: string;
  data: SambaModel[];
}

const SAMBANOVA_API = 'https://api.sambanova.ai/v1';

export class SambaNovaScraper extends BaseScraper {
  readonly id = 'sambanova';
  readonly category = 'inference' as const;
  readonly displayName = 'SambaNova';

  protected async doHandle(
    _msg: ScraperMessage,
    env: ScraperEnv,
  ): Promise<ScraperResult> {
    const apiKey = env.SAMBANOVA_API_KEY as string | undefined;
    if (!apiKey) throw new Error('SAMBANOVA_API_KEY not set');

    const res = await fetch(`${SAMBANOVA_API}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`sambanova /models: HTTP ${res.status}`);
    const catalog = (await res.json()) as SambaModelsResponse;
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
      const id = `sambanova/${m.id}`;
      const pricePrompt = Number(m.pricing?.prompt ?? 0);
      const priceCompletion = Number(m.pricing?.completion ?? 0);
      const isFree = pricePrompt === 0 && priceCompletion === 0;

      return stmt.bind(
        id,
        'sambanova-api',
        isFree ? 'free' : 'paid',
        'api',
        m.context_length ?? null,
        0,
        0,
        isFree ? 1 : 0,
        pricePrompt,
        priceCompletion,
        `https://api.sambanova.ai/v1/models/${m.id}`,
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
      .bind('sambanova-free-tier', 'sambanova', 'SambaNova Free Tier', 'credits', 1, 'documented', now)
      .run();

    return { offerings: rows.length, scores: 0, quotas: 1, note: `${rows.length} models from SambaNova API` };
  }
}
