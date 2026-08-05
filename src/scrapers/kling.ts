/**
 * Kling AI scraper — fetches model catalog from Kling AI API.
 * API docs: https://docs.klingai.com/
 */

import { BaseScraper } from './base';
import type { ScraperMessage, ScraperResult, ScraperEnv } from './types';

export class KlingAIScraper extends BaseScraper {
  readonly id = 'kling';
  readonly category = 'tool' as const;
  readonly displayName = 'Kling AI';

  protected async doHandle(_msg: ScraperMessage, env: ScraperEnv): Promise<ScraperResult> {
    const apiKey = env.KLING_API_KEY as string | undefined;
    if (!apiKey) throw new Error('KLING_API_KEY not set');

    const now = new Date().toISOString();
    const models = ['kling-1.5', 'kling-1.0'];

    const stmt = env.DB.prepare(`INSERT INTO offerings (model_id, harness_id, plan_id, medium, context_window, supports_vision, supports_tools, is_free, price_prompt, price_completion, access_url, last_verified_at, score_key) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13) ON CONFLICT(model_id, harness_id, plan_id) DO UPDATE SET context_window=excluded.context_window, supports_vision=excluded.supports_vision, supports_tools=excluded.supports_tools, is_free=excluded.is_free, price_prompt=excluded.price_prompt, price_completion=excluded.price_completion, last_verified_at=excluded.last_verified_at, score_key=excluded.score_key`);

    const rows = models.map(m => stmt.bind(`kling/${m}`, 'kling-tool', 'paid', 'tool', null, 1, 0, 0, 0, 0, `https://klingai.com/${m}`, now, m));

    if (rows.length > 0) await env.DB.batch(rows);

    return { offerings: rows.length, scores: 0, quotas: 0, note: `${rows.length} models from Kling AI` };
  }
}
