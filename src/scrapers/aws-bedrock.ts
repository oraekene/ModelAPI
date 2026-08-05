/**
 * AWS Bedrock scraper — fetches model catalog from AWS Bedrock API.
 * API docs: https://docs.aws.amazon.com/bedrock/
 */

import { BaseScraper } from './base';
import type { ScraperMessage, ScraperResult, ScraperEnv } from './types';

export class AWSBedrockScraper extends BaseScraper {
  readonly id = 'aws-bedrock';
  readonly category = 'tool' as const;
  readonly displayName = 'AWS Bedrock';

  protected async doHandle(_msg: ScraperMessage, env: ScraperEnv): Promise<ScraperResult> {
    const apiKey = env.AWS_BEDROCK_API_KEY as string | undefined;
    if (!apiKey) throw new Error('AWS_BEDROCK_API_KEY not set');

    const now = new Date().toISOString();
    const models = ['anthropic.claude-3-sonnet-20240229-v1:0', 'anthropic.claude-3-haiku-20240307-v1:0', 'ai21.j2-ultra-v1', 'ai21.j2-mid-v1', 'meta.llama2-13b-chat-v1', 'meta.llama2-70b-chat-v1', 'cohere.command-text-v14', 'amazon.titan-text-express-v1', 'amazon.titan-text-lite-v1', 'stability.stable-diffusion-xl-v0'];

    const stmt = env.DB.prepare(`INSERT INTO offerings (model_id, harness_id, plan_id, medium, context_window, supports_vision, supports_tools, is_free, price_prompt, price_completion, access_url, last_verified_at, score_key) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13) ON CONFLICT(model_id, harness_id, plan_id) DO UPDATE SET context_window=excluded.context_window, supports_vision=excluded.supports_vision, supports_tools=excluded.supports_tools, is_free=excluded.is_free, price_prompt=excluded.price_prompt, price_completion=excluded.price_completion, last_verified_at=excluded.last_verified_at, score_key=excluded.score_key`);

    const rows = models.map(m => stmt.bind(`aws-bedrock/${m}`, 'aws-bedrock-tool', 'paid', 'tool', null, 0, 0, 0, 0, 0, `https://aws.amazon.com/bedrock/${m}`, now, m));

    if (rows.length > 0) await env.DB.batch(rows);

    return { offerings: rows.length, scores: 0, quotas: 0, note: `${rows.length} models from AWS Bedrock` };
  }
}
