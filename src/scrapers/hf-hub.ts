/**
 * Hugging Face Hub scraper — fetches model catalog from HF Hub API.
 * API docs: https://huggingface.co/docs/hub/api
 */

import { BaseScraper } from './base';
import type { ScraperMessage, ScraperResult, ScraperEnv } from './types';

const HF_HUB_API = 'https://huggingface.co/api';

export class HfHubScraper extends BaseScraper {
  readonly id = 'hf-hub';
  readonly category = 'inference' as const;
  readonly displayName = 'Hugging Face Hub';

  protected async doHandle(_msg: ScraperMessage, env: ScraperEnv): Promise<ScraperResult> {
    const apiKey = env.HF_HUB_API_KEY as string | undefined;
    if (!apiKey) throw new Error('HF_HUB_API_KEY not set');

    const res = await fetch(`${HF_HUB_API}/models?limit=100&sort=downloads&direction=-1`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`hf-hub /models: HTTP ${res.status}`);
    const catalog = await res.json() as Array<{ id: string; modelId?: string; pipeline_tag?: string }>;
    const models = catalog ?? [];

    const now = new Date().toISOString();
    const stmt = env.DB.prepare(`INSERT INTO offerings (model_id, harness_id, plan_id, medium, context_window, supports_vision, supports_tools, is_free, price_prompt, price_completion, access_url, last_verified_at, score_key) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13) ON CONFLICT(model_id, harness_id, plan_id) DO UPDATE SET context_window=excluded.context_window, supports_vision=excluded.supports_vision, supports_tools=excluded.supports_tools, is_free=excluded.is_free, price_prompt=excluded.price_prompt, price_completion=excluded.price_completion, last_verified_at=excluded.last_verified_at, score_key=excluded.score_key`);

    const rows = models.map(m => {
      const modelId = m.modelId ?? m.id;
      const id = `hf-hub/${modelId}`;
      return stmt.bind(id, 'hf-hub-api', 'free', 'api', null, 0, 0, 1, 0, 0, `https://huggingface.co/${modelId}`, now, modelId);
    });

    if (rows.length > 0) await env.DB.batch(rows);

    return { offerings: rows.length, scores: 0, quotas: 0, note: `${rows.length} models from HF Hub API` };
  }
}
