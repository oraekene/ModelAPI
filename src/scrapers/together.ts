/**
 * Together AI scraper — fetches model catalog from Together API.
 *
 * Together AI offers inference with signup credits:
 *   - $5 free credits on signup
 *   - Pay-as-you-go after credits exhausted
 *
 * API docs: https://docs.together.ai/reference/models
 */

import { BaseScraper } from './base';
import type { ScraperMessage, ScraperResult, ScraperEnv } from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TogetherModel {
  id: string;
  object: string;
  created?: number | null;
  owned_by?: string | null;
  context_length?: number | null;
  pricing?: {
    prompt?: string | number | null;
    completion?: string | number | null;
  } | null;
  [key: string]: unknown;
}

export interface TogetherModelsResponse {
  object: string;
  data: TogetherModel[];
}

// ---------------------------------------------------------------------------
// Scraper
// ---------------------------------------------------------------------------

const TOGETHER_API = 'https://api.together.xyz/v1';

export class TogetherScraper extends BaseScraper {
  readonly id = 'together';
  readonly category = 'inference' as const;
  readonly displayName = 'Together AI';

  protected async doHandle(
    _msg: ScraperMessage,
    env: ScraperEnv,
  ): Promise<ScraperResult> {
    const apiKey = env.TOGETHER_API_KEY as string | undefined;
    if (!apiKey) {
      throw new Error('TOGETHER_API_KEY not set');
    }

    // Fetch model catalog
    const res = await fetch(`${TOGETHER_API}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      throw new Error(`together /models: HTTP ${res.status}`);
    }
    const catalog = (await res.json()) as TogetherModelsResponse;
    const models = catalog.data ?? [];

    // Normalize into offerings
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
      const id = `together/${m.id}`;
      // Determine if free: Together has no explicit free tier, but signup credits make
      // all models effectively free during trial. Mark as paid since credits are finite.
      const pricePrompt = Number(m.pricing?.prompt ?? 0);
      const priceCompletion = Number(m.pricing?.completion ?? 0);
      const isFree = pricePrompt === 0 && priceCompletion === 0;

      return stmt.bind(
        id,
        'together-api',
        isFree ? 'free' : 'paid',
        'api',
        m.context_length ?? null,
        0, // supports_vision — Together doesn't expose this in API
        0, // supports_tools — Together doesn't expose this in API
        isFree ? 1 : 0,
        pricePrompt,
        priceCompletion,
        `https://api.together.xyz/v1/models/${m.id}`,
        now,
        m.id, // score_key = base slug
      );
    });

    if (rows.length > 0) {
      await env.DB.batch(rows);
    }

    // Write quota pool for signup credits
    await env.DB.prepare(
      `INSERT INTO quota_pools (pool_id, platform, label, quota_unit, quota_value, confidence, last_verified_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(pool_id) DO UPDATE SET
         quota_value = excluded.quota_value,
         last_verified_at = excluded.last_verified_at`,
    )
      .bind(
        'together-credits',
        'together',
        'Together Signup Credits',
        'credits',
        5, // $5 free credits
        'documented',
        now,
      )
      .run();

    return {
      offerings: rows.length,
      scores: 0,
      quotas: 1,
      note: `${rows.length} models from Together API`,
    };
  }
}
