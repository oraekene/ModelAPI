/**
 * DeepSeek Web Crawler — scrapes https://chat.deepseek.com
 *
 * DeepSeek's website lists available models including DeepSeek-V3, R1, etc.
 * No API key needed for the chat interface.
 */

import { WebCrawlerScraper, type CrawledModel } from './web-crawler';

export class DeepSeekCrawler extends WebCrawlerScraper {
  readonly id = 'deepseek-crawl';
  readonly category = 'inference' as const;
  readonly displayName = 'DeepSeek (Web Crawl)';

  protected crawlUrls(): string[] {
    return [
      'https://chat.deepseek.com',
      'https://api-docs.deepseek.com',
    ];
  }

  protected parseHtml(url: string, html: string): CrawledModel[] {
    const models: CrawledModel[] = [];
    const seen = new Set<string>();

    // DeepSeek embeds model info in various places
    const modelPatterns = [
      /deepseek-[a-z0-9]+/gi,
      /DeepSeek-[A-Za-z0-9]+/g,
    ];

    for (const pattern of modelPatterns) {
      let match;
      while ((match = pattern.exec(html)) !== null) {
        const id = match[0].toLowerCase();
        if (seen.has(id)) continue;
        seen.add(id);

        const isFree = id.includes('chat') || id === 'deepseek-v3';
        models.push({
          modelId: `deepseek/${id}`,
          harnessId: 'deepseek-crawl',
          planId: isFree ? 'free' : 'paid',
          medium: 'inference',
          contextWindow: id.includes('v3') ? 65536 : null,
          supportsVision: 0,
          supportsTools: 1,
          isFree: isFree ? 1 : 0,
          pricePrompt: null,
          priceCompletion: null,
          accessUrl: 'https://chat.deepseek.com',
        });
      }
    }

    // Known DeepSeek models
    const knownModels = [
      { id: 'deepseek-chat', name: 'DeepSeek-V3', free: true },
      { id: 'deepseek-reasoner', name: 'DeepSeek-R1', free: false },
      { id: 'deepseek-v3', name: 'DeepSeek-V3 (API)', free: false },
      { id: 'deepseek-coder', name: 'DeepSeek Coder', free: false },
    ];

    for (const { id, free } of knownModels) {
      if (!seen.has(id)) {
        seen.add(id);
        models.push({
          modelId: `deepseek/${id}`,
          harnessId: 'deepseek-crawl',
          planId: free ? 'free' : 'paid',
          medium: 'inference',
          contextWindow: 65536,
          supportsVision: 0,
          supportsTools: 1,
          isFree: free ? 1 : 0,
          pricePrompt: null,
          priceCompletion: null,
          accessUrl: 'https://chat.deepseek.com',
        });
      }
    }

    return models;
  }
}
