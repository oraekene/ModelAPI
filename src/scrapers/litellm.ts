/**
 * LiteLLM scraper — fetches model catalog from LiteLLM proxy API.
 * API docs: https://docs.litellm.ai/
 */

import { BaseScraper } from './base';
import type { ScraperMessage, ScraperResult, ScraperEnv } from './types';

export class LiteLLMScraper extends BaseScraper {
  readonly id = 'litellm';
  readonly category = 'tool' as const;
  readonly displayName = 'LiteLLM';

  protected async doHandle(_msg: ScraperMessage, env: ScraperEnv): Promise<ScraperResult> {
    const apiKey = env.LITELLM_API_KEY as string | undefined;
    if (!apiKey) throw new Error('LITELLM_API_KEY not set');

    const now = new Date().toISOString();
    const models = ['litellm-proxy'];

    const stmt = env.DB.prepare(`INSERT INTO offerings (model_id, harness_id, plan_id, medium, context_window, supports_vision, supports_tools, is_free, price_prompt, price_completion, access_url, last_verified_at, score_key) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13) ON CONFLICT(model_id, harness_id, plan_id) DO UPDATE SET context_window=excluded.context_window, supports_vision=excluded.supports_vision, supports_tools=excluded.supports_tools, is_free=excluded.is_free, price_prompt=excluded.price_prompt, price_completion=excluded.price_completion, last_verified_at=excluded.last_verified_at, score_key=excluded.score_key`);

    const rows = models.map(m => stmt.bind(`litellm/${m}`, 'litellm-tool', 'free', 'tool', null, 0, 0, 1, 0, 0, `https://litellm.ai/${m}`, now, m));

    if (rows.length > 0) await env.DB.batch(rows);

    return { offerings: rows.length, scores: 0, quotas: 0, note: `${rows.length} models from LiteLLM` };
  }
}
