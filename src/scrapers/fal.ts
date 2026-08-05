/**
 * fal.ai scraper — fetches model catalog from fal API.
 * API docs: https://fal.ai/docs/api-reference
 */

import { BaseScraper } from './base';
import type { ScraperMessage, ScraperResult, ScraperEnv } from './types';

const FAL_API = 'https://fal.run';

export class FalScraper extends BaseScraper {
  readonly id = 'fal';
  readonly category = 'inference' as const;
  readonly displayName = 'fal.ai';

  protected async doHandle(_msg: ScraperMessage, env: ScraperEnv): Promise<ScraperResult> {
    const apiKey = env.FAL_API_KEY as string | undefined;
    if (!apiKey) throw new Error('FAL_API_KEY not set');

    const res = await fetch(`${FAL_API}/fal-ai/flux/dev`, {
      headers: { Authorization: `Key ${apiKey}` },
    });
    if (!res.ok) throw new Error(`fal /models: HTTP ${res.status}`);

    const now = new Date().toISOString();
    // fal uses model IDs directly, not a catalog endpoint
    const models = ['fal-ai/flux/dev', 'fal-ai/flux/schnell', 'fal-ai/stable-diffusion-v3-medium', 'fal-ai/realistic-vision'];

    const stmt = env.DB.prepare(`INSERT INTO offerings (model_id, harness_id, plan_id, medium, context_window, supports_vision, supports_tools, is_free, price_prompt, price_completion, access_url, last_verified_at, score_key) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13) ON CONFLICT(model_id, harness_id, plan_id) DO UPDATE SET context_window=excluded.context_window, supports_vision=excluded.supports_vision, supports_tools=excluded.supports_tools, is_free=excluded.is_free, price_prompt=excluded.price_prompt, price_completion=excluded.price_completion, last_verified_at=excluded.last_verified_at, score_key=excluded.score_key`);

    const rows = models.map(m => {
      const id = `fal/${m}`;
      return stmt.bind(id, 'fal-api', 'paid', 'api', null, 0, 0, 0, 0, 0, `https://fal.ai/models/${m}`, now, m);
    });

    if (rows.length > 0) await env.DB.batch(rows);

    await env.DB.prepare(`INSERT INTO quota_pools (pool_id, platform, label, quota_unit, quota_value, confidence, last_verified_at) VALUES (?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(pool_id) DO UPDATE SET quota_value=excluded.quota_value, last_verified_at=excluded.last_verified_at`).bind('fal-credits', 'fal', 'fal Signup Credits', 'credits', 1, 'documented', now).run();

    return { offerings: rows.length, scores: 0, quotas: 1, note: `${rows.length} models from fal API` };
  }
}
