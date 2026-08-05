/**
 * Hugging Face Hub Web Crawler — fetches models from the public API.
 *
 * https://huggingface.co/api/models returns model data without authentication.
 * We fetch the most downloaded models across different pipeline types.
 */

import { WebCrawlerScraper, type CrawledModel } from './web-crawler';

export class HuggingFaceCrawler extends WebCrawlerScraper {
  readonly id = 'hf-crawl';
  readonly category = 'inference' as const;
  readonly displayName = 'Hugging Face Hub (Web Crawl)';

  protected maxConcurrency = 2; // Be polite to HF

  protected crawlUrls(): string[] {
    return [
      // Text generation models (most relevant for LLM use cases)
      'https://huggingface.co/api/models?pipeline_tag=text-generation&sort=downloads&direction=-1&limit=100',
      // Text2text generation (encoder-decoder models)
      'https://huggingface.co/api/models?pipeline_tag=text2text-generation&sort=downloads&direction=-1&limit=50',
      // Conversational models
      'https://huggingface.co/api/models?pipeline_tag=conversational&sort=downloads&direction=-1&limit=50',
    ];
  }

  protected parseHtml(_url: string, html: string): CrawledModel[] {
    const models: CrawledModel[] = [];

    try {
      const items = JSON.parse(html);
      if (!Array.isArray(items)) return models;

      for (const m of items) {
        const id = m.id ?? m.modelId;
        if (!id) continue;

        // Extract license from tags
        const tags = m.tags ?? [];
        const license = tags.find((t: string) => t.startsWith('license:'))?.replace('license:', '') ?? 'unknown';

        // Determine if it's free (most HF models are free to download)
        const isFree = true;

        models.push({
          modelId: `hf/${id}`,
          harnessId: 'hf-crawl',
          planId: 'free',
          medium: 'inference',
          contextWindow: null,
          supportsVision: 0,
          supportsTools: 0,
          isFree: isFree ? 1 : 0,
          pricePrompt: null,
          priceCompletion: null,
          accessUrl: `https://huggingface.co/${id}`,
        });
      }
    } catch {
      // If JSON parsing fails, return empty
    }

    return models;
  }
}
