/**
 * Replicate scraper — fetches model catalog from Replicate API.
 * API docs: https://replicate.com/docs/reference/http
 */

import { BaseScraper } from './base';
import type { ScraperMessage, ScraperResult, ScraperEnv } from './types';

const REPLICATE_API = 'https://api.replicate.com/v1';

export class ReplicateScraper extends BaseScraper {
  readonly id = 'replicate';
  readonly category = 'inference' as const;
  readonly displayName = 'Replicate';

  protected async doHandle(_msg: ScraperMessage, env: ScraperEnv): Promise<ScraperResult> {
    const apiKey = env.REPLICATE_API_KEY as string | undefined;
    if (!apiKey) throw new Error('REPLICATE_API_KEY not set');

    const res = await fetch(`${REPLICATE_API}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`replicate /models: HTTP ${res.status}`);
    const catalog = await res.json() as { results: Array<{ url: string; name: string; description?: string; latest_version?: { id: string; schema?: Record<string, unknown> } }> };
    const models = catalog.results ?? [];

    const now = new Date().toISOString();
    const stmt = env.DB.prepare(`INSERT INTO offerings (model_id, harness_id, plan_id, medium, context_window, supports_vision, supports_tools, is_free, price_prompt, price_completion, access_url, last_verified_at, score_key) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13) ON CONFLICT(model_id, harness_id, plan_id) DO UPDATE SET context_window=excluded.context_window, supports_vision=excluded.supports_vision, supports_tools=excluded.supports_tools, is_free=excluded.is_free, price_prompt=excluded.price_prompt, price_completion=excluded.price_completion, last_verified_at=excluded.last_verified_at, score_key=excluded.score_key`);

    const rows = models.map(m => {
      const slug = m.url?.split('/').slice(-2).join('/') ?? m.name;
      const id = `replicate/${slug}`;
      return stmt.bind(id, 'replicate-api', 'paid', 'api', null, 0, 0, 0, 0, 0, `https://replicate.com/${slug}`, now, slug);
    });

    if (rows.length > 0) await env.DB.batch(rows);

    await env.DB.prepare(`INSERT INTO quota_pools (pool_id, platform, label, quota_unit, quota_value, confidence, last_verified_at) VALUES (?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(pool_id) DO UPDATE SET quota_value=excluded.quota_value, last_verified_at=excluded.last_verified_at`).bind('replicate-credits', 'replicate', 'Replicate Signup Credits', 'credits', 1, 'documented', now).run();

    return { offerings: rows.length, scores: 0, quotas: 1, note: `${rows.length} models from Replicate API` };
  }
}
