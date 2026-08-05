/**
 * Perplexity scraper — fetches model catalog from Perplexity API.
 * API docs: https://docs.perplexity.ai/
 */

import { BaseScraper } from './base';
import type { ScraperMessage, ScraperResult, ScraperEnv } from './types';

const PERPLEXITY_API = 'https://api.perplexity.ai';

export class PerplexityScraper extends BaseScraper {
  readonly id = 'perplexity';
  readonly category = 'lab' as const;
  readonly displayName = 'Perplexity';

  protected async doHandle(_msg: ScraperMessage, env: ScraperEnv): Promise<ScraperResult> {
    const apiKey = env.PERPLEXITY_API_KEY as string | undefined;
    if (!apiKey) throw new Error('PERPLEXITY_API_KEY not set');

    const res = await fetch(`${PERPLEXITY_API}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`perplexity /models: HTTP ${res.status}`);
    const catalog = await res.json() as { data: Array<{ id: string; name?: string; context_length?: number }> };
    const models = catalog.data ?? [];

    const now = new Date().toISOString();
    const stmt = env.DB.prepare(`INSERT INTO offerings (model_id, harness_id, plan_id, medium, context_window, supports_vision, supports_tools, is_free, price_prompt, price_completion, access_url, last_verified_at, score_key) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13) ON CONFLICT(model_id, harness_id, plan_id) DO UPDATE SET context_window=excluded.context_window, supports_vision=excluded.supports_vision, supports_tools=excluded.supports_tools, is_free=excluded.is_free, price_prompt=excluded.price_prompt, price_completion=excluded.price_completion, last_verified_at=excluded.last_verified_at, score_key=excluded.score_key`);

    const rows = models.map(m => {
      const id = `perplexity/${m.id}`;
      return stmt.bind(id, 'perplexity-api', 'paid', 'api', m.context_length ?? null, 0, 0, 0, 0, 0, `https://docs.perplexity.ai/models/${m.id}`, now, m.id);
    });

    if (rows.length > 0) await env.DB.batch(rows);

    await env.DB.prepare(`INSERT INTO quota_pools (pool_id, platform, label, quota_unit, quota_value, confidence, last_verified_at) VALUES (?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(pool_id) DO UPDATE SET quota_value=excluded.quota_value, last_verified_at=excluded.last_verified_at`).bind('perplexity-free-tier', 'perplexity', 'Perplexity Free Tier', 'credits', 1, 'documented', now).run();

    return { offerings: rows.length, scores: 0, quotas: 1, note: `${rows.length} models from Perplexity API` };
  }
}
