/**
 * Google Gemini scraper — fetches model catalog from Gemini API.
 * API docs: https://ai.google.dev/docs
 */

import { BaseScraper } from './base';
import type { ScraperMessage, ScraperResult, ScraperEnv } from './types';

const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta';

export class GeminiScraper extends BaseScraper {
  readonly id = 'gemini';
  readonly category = 'lab' as const;
  readonly displayName = 'Google Gemini';

  protected async doHandle(_msg: ScraperMessage, env: ScraperEnv): Promise<ScraperResult> {
    const apiKey = env.GEMINI_API_KEY as string | undefined;
    if (!apiKey) throw new Error('GEMINI_API_KEY not set');

    const res = await fetch(`${GEMINI_API}/models?key=${apiKey}`);
    if (!res.ok) throw new Error(`gemini /models: HTTP ${res.status}`);
    const catalog = await res.json() as { models: Array<{ name: string; displayName?: string; inputTokenLimit?: number; outputTokenLimit?: number }> };
    const models = catalog.models ?? [];

    const now = new Date().toISOString();
    const stmt = env.DB.prepare(`INSERT INTO offerings (model_id, harness_id, plan_id, medium, context_window, supports_vision, supports_tools, is_free, price_prompt, price_completion, access_url, last_verified_at, score_key) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13) ON CONFLICT(model_id, harness_id, plan_id) DO UPDATE SET context_window=excluded.context_window, supports_vision=excluded.supports_vision, supports_tools=excluded.supports_tools, is_free=excluded.is_free, price_prompt=excluded.price_prompt, price_completion=excluded.price_completion, last_verified_at=excluded.last_verified_at, score_key=excluded.score_key`);

    const rows = models.map(m => {
      const name = m.name.replace('models/', '');
      const id = `gemini/${name}`;
      return stmt.bind(id, 'gemini-api', 'free', 'api', m.inputTokenLimit ?? null, 0, 0, 1, 0, 0, `https://ai.google.dev/models/${name}`, now, name);
    });

    if (rows.length > 0) await env.DB.batch(rows);

    await env.DB.prepare(`INSERT INTO quota_pools (pool_id, platform, label, quota_unit, quota_value, confidence, last_verified_at) VALUES (?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(pool_id) DO UPDATE SET quota_value=excluded.quota_value, last_verified_at=excluded.last_verified_at`).bind('gemini-free-tier', 'gemini', 'Gemini Free Tier', 'requests_per_day', 1500, 'documented', now).run();

    return { offerings: rows.length, scores: 0, quotas: 1, note: `${rows.length} models from Gemini API` };
  }
}
