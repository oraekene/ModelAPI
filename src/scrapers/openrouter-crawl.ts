/**
 * OpenRouter Web Crawler — fetches models from the public API.
 *
 * https://openrouter.ai/api/v1/models returns 300+ models with full
 * structured data (pricing, context windows, capabilities) — no API key needed.
 */

import { WebCrawlerScraper, type CrawledModel } from './web-crawler';

export class OpenRouterCrawler extends WebCrawlerScraper {
  readonly id = 'openrouter-crawl';
  readonly category = 'inference' as const;
  readonly displayName = 'OpenRouter (Web Crawl)';

  protected crawlUrls(): string[] {
    return ['https://openrouter.ai/api/v1/models'];
  }

  protected parseHtml(_url: string, html: string): CrawledModel[] {
    const models: CrawledModel[] = [];

    try {
      const data = JSON.parse(html);
      const items = data.data ?? data;

      if (!Array.isArray(items)) return models;

      for (const m of items) {
        const id = m.id ?? m.slug;
        if (!id) continue;

        // Skip aliases (they redirect to other models)
        if (m.alias_target) continue;

        const promptPrice = parseFloat(m.pricing?.prompt ?? '0');
        const completionPrice = parseFloat(m.pricing?.completion ?? '0');
        const isFree = promptPrice === 0 && completionPrice === 0;

        const modality = m.architecture?.modality ?? '';
        const supportsVision = modality.includes('image') || modality.includes('video') ? 1 : 0;
        const supportedParams = m.supported_parameters ?? [];
        const supportsTools = supportedParams.includes('tools') ? 1 : 0;

        models.push({
          modelId: `openrouter/${id}`,
          harnessId: 'openrouter-crawl',
          planId: isFree ? 'free' : 'paid',
          medium: 'inference',
          contextWindow: m.context_length ?? m.top_provider?.context_length ?? null,
          supportsVision,
          supportsTools,
          isFree: isFree ? 1 : 0,
          pricePrompt: promptPrice || null,
          priceCompletion: completionPrice || null,
          accessUrl: `https://openrouter.ai/${id}`,
        });
      }
    } catch {
      // If JSON parsing fails, return empty
    }

    return models;
  }
}
