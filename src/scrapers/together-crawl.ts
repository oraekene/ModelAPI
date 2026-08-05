/**
 * Together AI Web Crawler — scrapes https://www.together.ai/models
 *
 * Together's model page lists available models with pricing.
 * No API key needed.
 */

import { WebCrawlerScraper, type CrawledModel } from './web-crawler';

export class TogetherCrawler extends WebCrawlerScraper {
  readonly id = 'together-crawl';
  readonly category = 'inference' as const;
  readonly displayName = 'Together AI (Web Crawl)';

  protected crawlUrls(): string[] {
    return [
      'https://www.together.ai/models',
      'https://docs.together.ai/docs/serverless-models',
    ];
  }

  protected parseHtml(url: string, html: string): CrawledModel[] {
    const models: CrawledModel[] = [];
    const seen = new Set<string>();

    // Together's model pages contain model IDs in various formats.
    const modelRegex = /(?:model[_-]?id|name)["']?\s*[:=]\s*["']([a-z0-9/.-]+)/gi;
    let match;
    while ((match = modelRegex.exec(html)) !== null) {
      const id = match[1];
      if (seen.has(id) || id.length < 5) continue;
      if (id.startsWith('http') || id.includes('api')) continue;
      seen.add(id);

      // Try to find pricing near the model reference
      const nearby = html.slice(Math.max(0, match.index - 200), match.index + 500);
      const priceMatch = nearby.match(/\$?([\d.]+)\s*\/?\s*(?:per\s+)?(\d+[km]?)\s*(?:tokens?)?/i);
      let pricePerToken: number | null = null;
      if (priceMatch) {
        const price = parseFloat(priceMatch[1]);
        const unit = priceMatch[2].toLowerCase();
        const divisor = unit.endsWith('k') ? 1000 : 1_000_000;
        pricePerToken = price / divisor;
      }

      const isFree = pricePerToken === null || pricePerToken === 0;

      models.push({
        modelId: `together/${id}`,
        harnessId: 'together-crawl',
        planId: isFree ? 'free' : 'paid',
        medium: 'inference',
        contextWindow: null,
        supportsVision: 0,
        supportsTools: 0,
        isFree: isFree ? 1 : 0,
        pricePrompt: pricePerToken,
        priceCompletion: pricePerToken ? pricePerToken * 2 : null, // rough estimate
        accessUrl: url.includes('docs') ? `https://docs.together.ai` : `https://www.together.ai/models`,
      });
    }

    // Known Together models as fallback
    const knownModels = [
      'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      'meta-llama/Llama-3.1-405B-Instruct-Turbo',
      'meta-llama/Llama-3.1-70B-Instruct-Turbo',
      'meta-llama/Llama-3.1-8B-Instruct-Turbo',
      'Qwen/Qwen2.5-72B-Instruct-Turbo',
      'Qwen/Qwen2.5-32B-Instruct-Turbo',
      'Qwen/Qwen2.5-Coder-32B-Instruct',
      'deepseek-ai/DeepSeek-V3',
      'deepseek-ai/DeepSeek-R1',
      'mistralai/Mistral-Small-24B-Instruct-2501',
      'mistralai/Mixtral-8x22B-Instruct-v0.1',
      'google/gemma-2-27b-it',
      'databricks/dbrx-instruct-preview',
      'NousResearch/Nous-Hermes-2-Yi-34B',
    ];

    for (const model of knownModels) {
      if (!seen.has(model) && html.includes(model.split('/').pop()!)) {
        seen.add(model);
        models.push({
          modelId: `together/${model}`,
          harnessId: 'together-crawl',
          planId: 'paid',
          medium: 'inference',
          contextWindow: null,
          supportsVision: 0,
          supportsTools: 0,
          isFree: 0,
          pricePrompt: null,
          priceCompletion: null,
          accessUrl: `https://www.together.ai/models`,
        });
      }
    }

    return models;
  }
}
