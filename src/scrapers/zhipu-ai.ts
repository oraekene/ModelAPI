/**
 * Zhipu AI scraper — fetches model catalog from Zhipu AI API.
 * API docs: https://open.bigmodel.cn/dev/api
 */

import { BaseScraper } from './base';
import type { ScraperMessage, ScraperResult, ScraperEnv } from './types';

const ZHIPU_AI_API = 'https://open.bigmodel.cn/api/paas/v4';

export class ZhipuAIScraper extends BaseScraper {
  readonly id = 'zhipu-ai';
  readonly category = 'lab' as const;
  readonly displayName = 'Zhipu AI';

  protected async doHandle(_msg: ScraperMessage, env: ScraperEnv): Promise<ScraperResult> {
    const apiKey = env.ZHIPU_AI_API_KEY as string | undefined;
    if (!apiKey) throw new Error('ZHIPU_AI_API_KEY not set');

    const res = await fetch(`${ZHIPU_AI_API}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`zhipu-ai /models: HTTP ${res.status}`);
    const catalog = await res.json() as { data: Array<{ id: string; name?: string; context_length?: number }> };
    const models = catalog.data ?? [];

    const now = new Date().toISOString();
    const stmt = env.DB.prepare(`INSERT INTO offerings (model_id, harness_id, plan_id, medium, context_window, supports_vision, supports_tools, is_free, price_prompt, price_completion, access_url, last_verified_at, score_key) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13) ON CONFLICT(model_id, harness_id, plan_id) DO UPDATE SET context_window=excluded.context_window, supports_vision=excluded.supports_vision, supports_tools=excluded.supports_tools, is_free=excluded.is_free, price_prompt=excluded.price_prompt, price_completion=excluded.price_completion, last_verified_at=excluded.last_verified_at, score_key=excluded.score_key`);

    const rows = models.map(m => {
      const id = `zhipu-ai/${m.id}`;
      return stmt.bind(id, 'zhipu-ai-api', 'free', 'api', m.context_length ?? null, 0, 0, 1, 0, 0, `https://open.bigmodel.cn/models/${m.id}`, now, m.id);
    });

    if (rows.length > 0) await env.DB.batch(rows);

    await env.DB.prepare(`INSERT INTO quota_pools (pool_id, platform, label, quota_unit, quota_value, confidence, last_verified_at) VALUES (?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(pool_id) DO UPDATE SET quota_value=excluded.quota_value, last_verified_at=excluded.last_verified_at`).bind('zhipu-ai-free-tier', 'zhipu-ai', 'Zhipu AI Free Tier', 'tokens_per_day', 1000000, 'documented', now).run();

    return { offerings: rows.length, scores: 0, quotas: 1, note: `${rows.length} models from Zhipu AI API` };
  }
}
