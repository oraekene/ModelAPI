/**
 * Groq scraper — fetches model catalog from Groq API.
 *
 * Groq offers fast inference with free-tier quotas:
 *   - 14,400 requests/day (free)
 *   - 30 requests/minute (free)
 *   - 6,000 tokens/minute (free)
 *
 * API docs: https://console.groq.com/docs/api-reference
 */

import { BaseScraper } from './base';
import type { ScraperMessage, ScraperResult, ScraperEnv } from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GroqModel {
  id: string;
  object: string;
  created: number;
  owned_by: string;
  active: boolean;
  context_window?: number | null;
  supports_tools?: boolean | null;
  supports_vision?: boolean | null;
  [key: string]: unknown;
}

export interface GroqModelsResponse {
  object: string;
  data: GroqModel[];
}

// ---------------------------------------------------------------------------
// Scraper
// ---------------------------------------------------------------------------

const GROQ_API = 'https://api.groq.com/openai/v1';

export class GroqScraper extends BaseScraper {
  readonly id = 'groq';
  readonly category = 'inference' as const;
  readonly displayName = 'Groq';

  protected async doHandle(
    _msg: ScraperMessage,
    env: ScraperEnv,
  ): Promise<ScraperResult> {
    const apiKey = env.GROQ_API_KEY as string | undefined;
    if (!apiKey) {
      throw new Error('GROQ_API_KEY not set');
    }

    // Fetch model catalog
    const res = await fetch(`${GROQ_API}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      throw new Error(`groq /models: HTTP ${res.status}`);
    }
    const catalog = (await res.json()) as GroqModelsResponse;
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

    const rows = models
      .filter((m) => m.active)
      .map((m) => {
        const id = `groq/${m.id}`;
        return stmt.bind(
          id,
          'groq-api',
          'free', // Groq only has free tier for now
          'api',
          m.context_window ?? null,
          m.supports_vision ? 1 : 0,
          m.supports_tools ? 1 : 0,
          1, // is_free = 1
          0, // price_prompt = 0 (free)
          0, // price_completion = 0 (free)
          `https://console.groq.com/docs/${m.id}`,
          now,
          m.id, // score_key = base slug
        );
      });

    if (rows.length > 0) {
      await env.DB.batch(rows);
    }

    // Write quota pool for free tier
    await env.DB.prepare(
      `INSERT INTO quota_pools (pool_id, platform, label, quota_unit, quota_value, confidence, last_verified_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(pool_id) DO UPDATE SET
         quota_value = excluded.quota_value,
         last_verified_at = excluded.last_verified_at`,
    )
      .bind(
        'groq-free',
        'groq',
        'Groq Free Tier',
        'requests/day',
        14_400,
        'documented',
        now,
      )
      .run();

    return {
      offerings: rows.length,
      scores: 0,
      quotas: 1,
      note: `${rows.length} models from Groq API`,
    };
  }
}
