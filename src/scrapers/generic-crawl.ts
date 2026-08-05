/**
 * Generic Web Crawler — attempts to crawl any URL for model information.
 *
 * This is a best-effort crawler that tries common patterns to extract
 * model data from any website. Works well for:
 *   - Platforms with standard HTML structure
 *   - Sites that list models in tables or cards
 *   - Pages with JSON-LD structured data
 *
 * For best results, use the platform-specific crawlers instead.
 */

import { WebCrawlerScraper, type CrawledModel } from './web-crawler';

export class GenericCrawler extends WebCrawlerScraper {
  readonly id = 'generic-crawl';
  readonly category = 'inference' as const;
  readonly displayName = 'Generic Web Crawler';

  /** URLs to crawl — set dynamically via the message payload. */
  private _urls: string[] = [];
  /** Platform name for model IDs. */
  private _platform = 'unknown';
  /** Base URL for model access. */
  private _baseUrl = '';

  /**
   * Configure the crawler with target URLs and platform info.
   * Called before handle() when using via /admin/crawl.
   */
  configure(urls: string[], platform: string, baseUrl: string): void {
    this._urls = urls;
    this._platform = platform;
    this._baseUrl = baseUrl;
  }

  protected crawlUrls(): string[] {
    return this._urls;
  }

  protected parseHtml(url: string, html: string): CrawledModel[] {
    const models: CrawledModel[] = [];
    const seen = new Set<string>();

    // Strategy 1: Look for JSON-LD structured data
    const jsonLd = this.extractJsonLd(html);
    for (const data of jsonLd) {
      if (typeof data === 'object' && data !== null) {
        const items = Array.isArray(data) ? data : [data];
        for (const item of items) {
          const obj = item as Record<string, unknown>;
          if (obj['@type'] === 'Product' || obj['@type'] === 'SoftwareApplication') {
            const name = (obj.name as string) ?? '';
            if (name && !seen.has(name)) {
              seen.add(name);
              models.push(this.createModel(name, url));
            }
          }
        }
      }
    }

    // Strategy 2: Look for model-like patterns in the HTML
    const modelPatterns = [
      // Common model naming: provider/model-name
      /["']([a-z]+\/[a-z0-9.-]+)["']/gi,
      // Model IDs in data attributes
      /data-model["']=["']([^"']+)["']/gi,
      // Model names in headings
      /<h[1-6][^>]*>([^<]*(?:model|ai|llm|gpt|claude|gemini|llama|mistral)[^<]*)<\/h[1-6]>/gi,
      // Model info in list items
      /<li[^>]*>([^<]*(?:model|ai|llm)[^<]*)<\/li>/gi,
    ];

    for (const pattern of modelPatterns) {
      let match;
      while ((match = pattern.exec(html)) !== null) {
        const raw = match[1].trim();
        if (raw.length < 3 || raw.length > 100) continue;
        if (seen.has(raw)) continue;
        if (raw.includes('http') || raw.includes('www.')) continue;
        seen.add(raw);

        models.push(this.createModel(raw, url));
      }
    }

    // Strategy 3: Look for tables with model data
    const tableRegex = /<table[^>]*>([\s\S]*?)<\/table>/gi;
    let tableMatch;
    while ((tableMatch = tableRegex.exec(html)) !== null) {
      const tableHtml = tableMatch[1];
      const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
      let rowMatch;
      while ((rowMatch = rowRegex.exec(tableHtml)) !== null) {
        const cells = rowMatch[1].match(/<td[^>]*>([\s\S]*?)<\/td>/gi);
        if (cells && cells.length >= 2) {
          const firstCell = this.stripTags(cells[0]);
          if (firstCell.length > 3 && firstCell.length < 100 && !seen.has(firstCell)) {
            // Check if it looks like a model name
            if (/[a-z]/.test(firstCell) && /\d/.test(firstCell)) {
              seen.add(firstCell);
              models.push(this.createModel(firstCell, url));
            }
          }
        }
      }
    }

    return models;
  }

  private createModel(name: string, sourceUrl: string): CrawledModel {
    const id = name.toLowerCase().replace(/[^a-z0-9/.-]/g, '-').replace(/-+/g, '-');
    return {
      modelId: `${this._platform}/${id}`,
      harnessId: `${this._platform}-crawl`,
      planId: 'paid',
      medium: 'inference',
      contextWindow: null,
      supportsVision: 0,
      supportsTools: 0,
      isFree: 0,
      pricePrompt: null,
      priceCompletion: null,
      accessUrl: this._baseUrl || sourceUrl,
    };
  }
}
