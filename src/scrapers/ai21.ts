/**
 * AI21 Labs scraper — fetches model catalog from AI21 API.
 * API docs: https://docs.ai21.com/
 */

import { BaseScraper } from './base';
import type { ScraperMessage, ScraperResult, ScraperEnv } from './types';

const AI21_API = 'https://api.ai21.com/v1';

export class AI21Scraper extends BaseScraper {
  readonly id = 'ai21';
  readonly category = 'lab' as const;
  readonly displayName = 'AI21 Labs';

  protected async doHandle(_msg: ScraperMessage, env: ScraperEnv): Promise<ScraperResult> {
    const apiKey = env.AI21_API_KEY as string | undefined;
    if (!apiKey) throw new Error('AI21_API_KEY not set');

    const res = await fetch(`${AI21_API}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`ai21 /models: HTTP ${res.status}`);
    const catalog = await res.json() as { models: Array<{ name: string; displayName?: string; contextLength?: number }> };
    const models = catalog.models ?? [];

    const now = new Date().toISOString();
    const stmt = env.DB.prepare(`INSERT INTO offerings (model_id, harness_id, plan_id, medium, context_window, supports_vision, supports_tools, is_free, price_prompt, price_completion, access_url, last_verified_at, score_key) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13) ON CONFLICT(model_id, harness_id, plan_id) DO UPDATE SET context_window=excluded.context_window, supports_vision=excluded.supports_vision, supports_tools=excluded.supports_tools, is_free=excluded.is_free, price_prompt=excluded.price_prompt, price_completion=excluded.price_completion, last_verified_at=excluded.last_verified_at, score_key=excluded.score_key`);

    const rows = models.map(m => {
      const id = `ai21/${m.name}`;
      return stmt.bind(id, 'ai21-api', 'paid', 'api', m.contextLength ?? null, 0, 0, 0, 0, 0, `https://docs.ai21.com/models/${m.name}`, now, m.name);
    });

    if (rows.length > 0) await env.DB.batch(rows);

    await env.DB.prepare(`INSERT INTO quota_pools (pool_id, platform, label, quota_unit, quota_value, confidence, last_verified_at) VALUES (?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(pool_id) DO UPDATE SET quota_value=excluded.quota_value, last_verified_at=excluded.last_verified_at`).bind('ai21-free-tier', 'ai21', 'AI21 Free Tier', 'credits', 1, 'documented', now).run();

    return { offerings: rows.length, scores: 0, quotas: 1, note: `${rows.length} models from AI21 API` };
  }
}
