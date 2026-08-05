/**
 * Fireworks AI Web Crawler — scrapes https://fireworks.ai/models
 *
 * Fireworks' model page lists available models with pricing.
 * No API key needed.
 */

import { WebCrawlerScraper, type CrawledModel } from './web-crawler';

export class FireworksCrawler extends WebCrawlerScraper {
  readonly id = 'fireworks-crawl';
  readonly category = 'inference' as const;
  readonly displayName = 'Fireworks AI (Web Crawl)';

  protected crawlUrls(): string[] {
    return ['https://fireworks.ai/models'];
  }

  protected parseHtml(_url: string, html: string): CrawledModel[] {
    const models: CrawledModel[] = [];
    const seen = new Set<string>();

    // Fireworks uses accounts/fireworks/models/<model-id> format
    const modelRegex = /accounts\/fireworks\/models\/([a-z0-9-]+)/gi;
    let match;
    while ((match = modelRegex.exec(html)) !== null) {
      const id = match[1];
      if (seen.has(id)) continue;
      seen.add(id);

      models.push({
        modelId: `fireworks/${id}`,
        harnessId: 'fireworks-crawl',
        planId: 'paid',
        medium: 'inference',
        contextWindow: null,
        supportsVision: 0,
        supportsTools: 0,
        isFree: 0,
        pricePrompt: null,
        priceCompletion: null,
        accessUrl: `https://fireworks.ai/models`,
      });
    }

    // Known Fireworks models
    const knownModels = [
      'accounts/fireworks/models/llama-v3p3-70b-instruct',
      'accounts/fireworks/models/llama-v3p1-405b-instruct',
      'accounts/fireworks/models/llama-v3p1-70b-instruct',
      'accounts/fireworks/models/llama-v3p1-8b-instruct',
      'accounts/fireworks/models/mixtral-8x22b-instruct',
      'accounts/fireworks/models/qwen-72b-instruct',
      'accounts/fireworks/models/deepseek-v3',
      'accounts/fireworks/models/stable-diffusion-xl',
      'accounts/fireworks/models/accounts/fireworks/models/whisper-v3',
    ];

    for (const model of knownModels) {
      const shortId = model.split('/').pop()!;
      if (!seen.has(shortId) && html.includes(shortId)) {
        seen.add(shortId);
        models.push({
          modelId: `fireworks/${shortId}`,
          harnessId: 'fireworks-crawl',
          planId: 'paid',
          medium: 'inference',
          contextWindow: null,
          supportsVision: 0,
          supportsTools: 0,
          isFree: 0,
          pricePrompt: null,
          priceCompletion: null,
          accessUrl: `https://fireworks.ai/models`,
        });
      }
    }

    return models;
  }
}
