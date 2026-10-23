/**
 * Groq Web Crawler - scrapes https://console.groq.com/docs/models
 *
 * The docs page links every model to /docs/model/<id>. Reading those links
 * avoids matching webpack chunk names, UUIDs and CSS classes that a generic
 * deepseek-style token scan picks up.
 */

import { WebCrawlerScraper, type CrawledModel } from './web-crawler';

export class GroqCrawler extends WebCrawlerScraper {
  readonly id = 'groq-crawl';
  readonly category = 'inference' as const;
  readonly displayName = 'Groq (Web Crawl)';

  protected crawlUrls(): string[] {
    return [
      'https://console.groq.com/docs/models',
      'https://console.groq.com/docs/rate-limits',
    ];
  }

  protected parseHtml(_url: string, html: string): CrawledModel[] {
    const models: CrawledModel[] = [];
    const seen = new Set<string>();

    for (const match of html.matchAll(/href="\/docs\/model\/([a-z0-9][a-z0-9._/-]*)"/gi)) {
      const id = match[1].toLowerCase().replace(/\/$/, '');
      if (seen.has(id) || !this.isLikelyModelId(id)) continue;
      seen.add(id);
      models.push(this.buildModel(id, html, match.index ?? 0));
    }

    return models;
  }

  private isLikelyModelId(id: string): boolean {
    if (id.length < 3 || id.length > 80) return false;
    if (/\/(limits|price)$/.test(id)) return false;
    const exclusions = ['http', 'api', 'docs', 'console', 'groq', 'com', 'www', 'blog', 'models'];
    return !exclusions.includes(id);
  }

  private buildModel(id: string, html: string, matchIndex: number): CrawledModel {
    const nearby = html.slice(Math.max(0, matchIndex - 300), matchIndex + 500);
    const contextWindow = this.extractContextWindow(nearby, id);
    const caps = this.detectCapabilities(id);
    const nonChat = /whisper|orpheus|guard|reranker|embed/i.test(id);

    return {
      modelId: `groq/${id}`,
      scoreKey: id,
      harnessId: 'groq-crawl',
      planId: 'free',
      medium: 'inference',
      contextWindow,
      supportsVision: nonChat ? 0 : caps.supportsVision || (id.includes('vision') ? 1 : 0),
      supportsTools: nonChat ? 0 : 1,
      isFree: 1,
      pricePrompt: null,
      priceCompletion: null,
      accessUrl: `https://console.groq.com/docs/model/${id}`,
    };
  }
}
