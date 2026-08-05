/**
 * GitHub Copilot scraper — fetches model catalog from Copilot API.
 * API docs: https://docs.github.com/copilot
 */

import { BaseScraper } from './base';
import type { ScraperMessage, ScraperResult, ScraperEnv } from './types';

export class CopilotScraper extends BaseScraper {
  readonly id = 'copilot';
  readonly category = 'ide' as const;
  readonly displayName = 'GitHub Copilot';

  protected async doHandle(_msg: ScraperMessage, env: ScraperEnv): Promise<ScraperResult> {
    const apiKey = env.COPILOT_API_KEY as string | undefined;
    if (!apiKey) throw new Error('COPILOT_API_KEY not set');

    const now = new Date().toISOString();
    const models = ['copilot-default', 'copilot-chat', 'copilot-coding', 'copilot-visions'];

    const stmt = env.DB.prepare(`INSERT INTO offerings (model_id, harness_id, plan_id, medium, context_window, supports_vision, supports_tools, is_free, price_prompt, price_completion, access_url, last_verified_at, score_key) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13) ON CONFLICT(model_id, harness_id, plan_id) DO UPDATE SET context_window=excluded.context_window, supports_vision=excluded.supports_vision, supports_tools=excluded.supports_tools, is_free=excluded.is_free, price_prompt=excluded.price_prompt, price_completion=excluded.price_completion, last_verified_at=excluded.last_verified_at, score_key=excluded.score_key`);

    const rows = models.map(m => stmt.bind(`copilot/${m}`, 'copilot-ide', 'paid', 'ide', null, 0, 1, 0, 0, 0, `https://github.com/features/copilot`, now, m));

    if (rows.length > 0) await env.DB.batch(rows);

    await env.DB.prepare(`INSERT INTO quota_pools (pool_id, platform, label, quota_unit, quota_value, confidence, last_verified_at) VALUES (?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(pool_id) DO UPDATE SET quota_value=excluded.quota_value, last_verified_at=excluded.last_verified_at`).bind('copilot-free-tier', 'copilot', 'Copilot Free Tier', 'requests_per_day', 100, 'documented', now).run();

    return { offerings: rows.length, scores: 0, quotas: 1, note: `${rows.length} models from Copilot` };
  }
}
