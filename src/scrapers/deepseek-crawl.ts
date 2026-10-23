/**
 * DeepSeek Web Crawler - scrapes https://api-docs.deepseek.com
 *
 * The API docs list the model names accepted by the API in a small table.
 * Reading that table is more reliable than scanning the whole page for
 * deepseek-* strings, which also match marketing and asset names.
 */

import { WebCrawlerScraper, type CrawledModel } from './web-crawler';

export class DeepSeekCrawler extends WebCrawlerScraper {
  readonly id = 'deepseek-crawl';
  readonly category = 'inference' as const;
  readonly displayName = 'DeepSeek (Web Crawl)';

  protected crawlUrls(): string[] {
    return ['https://api-docs.deepseek.com'];
  }

  protected parseHtml(url: string, html: string): CrawledModel[] {
    const models: CrawledModel[] = [];
    const modelCell = html.match(/<td>\s*model\s*<\/td>\s*<td>([\s\S]*?)<\/td>/i);
    if (!modelCell) return models;

    const seen = new Set<string>();
    for (const match of modelCell[1].matchAll(/<code>(deepseek-[a-z0-9-]+)<\/code>/gi)) {
      const id = match[1].toLowerCase();
      if (seen.has(id) || !this.isDeepSeekModelId(id)) continue;
      seen.add(id);
      models.push(this.buildModel(id, html, match.index ?? 0, url));
    }

    return models;
  }

  private isDeepSeekModelId(id: string): boolean {
    if (!id.startsWith('deepseek-')) return false;
    if (id.length < 12 || id.length > 40) return false;
    const exclusions = ['deepseek-api', 'deepseek-docs', 'deepseek-com', 'deepseek-www'];
    return !exclusions.includes(id);
  }

  private buildModel(id: string, html: string, matchIndex: number, sourceUrl: string): CrawledModel {
    const nearby = html.slice(Math.max(0, matchIndex - 300), matchIndex + 500);
    const contextWindow = this.extractContextWindow(nearby, id);

    return {
      modelId: `deepseek/${id}`,
      scoreKey: id,
      harnessId: 'deepseek-crawl',
      planId: 'paid',
      medium: 'inference',
      contextWindow,
      supportsVision: 0,
      supportsTools: 1,
      isFree: 0,
      pricePrompt: null,
      priceCompletion: null,
      accessUrl: sourceUrl,
    };
  }
}
