/**
 * DeepSeek Web Crawler — scrapes https://chat.deepseek.com
 * and https://api-docs.deepseek.com
 *
 * DeepSeek's website lists available models including DeepSeek-V3, R1, etc.
 * No API key needed for the chat interface.
 *
 * Enhanced with Scrapling-inspired techniques:
 * - JSON extraction from embedded data
 * - API documentation parsing
 * - Model capability detection
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
      'https://api-docs.deepseek.com/guides/reasoning_model',
    ];
  }

  protected parseHtml(url: string, html: string): CrawledModel[] {
    const models: CrawledModel[] = [];
    const seen = new Set<string>();

    // Strategy 1: Extract from embedded JSON/Next.js data
    const jsonData = this.extractJsonFromScripts(html, /model|deepseek|reasoning/i);
    for (const data of jsonData) {
      const found = this.extractFromJson(data, url);
      for (const m of found) {
        if (!seen.has(m.modelId)) {
          seen.add(m.modelId);
          models.push(m);
        }
      }
    }

    // Strategy 2: Extract from JSON-LD
    const jsonLd = this.extractJsonLd(html);
    for (const data of jsonLd) {
      const found = this.extractFromJson(data, url);
      for (const m of found) {
        if (!seen.has(m.modelId)) {
          seen.add(m.modelId);
          models.push(m);
        }
      }
    }

    // Strategy 3: Pattern matching for DeepSeek model IDs
    const modelPatterns = [
      // DeepSeek model format: deepseek-v3, deepseek-chat, deepseek-reasoner
      /\b(deepseek-[a-z][a-z0-9-]*)\b/gi,
      // Model names in headings
      /<h[1-6][^>]*>([^<]*(?:DeepSeek|deepseek)[^<]*)<\/h[1-6]>/gi,
      // Code blocks with model references
      /<code[^>]*>(deepseek-[a-z][a-z0-9-]*)<\/code>/gi,
      // API model parameters
      /model["']?\s*[:=]\s*["'](deepseek-[a-z][a-z0-9-]*)/gi,
    ];

    for (const pattern of modelPatterns) {
      let match;
      while ((match = pattern.exec(html)) !== null) {
        const id = match[1].toLowerCase();
        if (seen.has(id)) continue;
        if (this.isDeepSeekModelId(id)) {
          seen.add(id);
          models.push(this.buildModel(id, html, match.index, url));
        }
      }
    }

    // Strategy 4: Known DeepSeek models (fallback)
    const knownModels = [
      { id: 'deepseek-chat', name: 'DeepSeek-V3', ctx: 65_536, free: true, reasoning: false },
      { id: 'deepseek-reasoner', name: 'DeepSeek-R1', ctx: 65_536, free: false, reasoning: true },
      { id: 'deepseek-v3', name: 'DeepSeek-V3 (API)', ctx: 65_536, free: false, reasoning: false },
      { id: 'deepseek-coder', name: 'DeepSeek Coder', ctx: 128_000, free: false, reasoning: false },
    ];

    for (const { id, ctx, free, reasoning } of knownModels) {
      if (!seen.has(id) && html.toLowerCase().includes(id)) {
        seen.add(id);
        models.push({
          modelId: `deepseek/${id}`,
          harnessId: 'deepseek-crawl',
          planId: free ? 'free' : 'paid',
          medium: 'inference',
          contextWindow: ctx,
          supportsVision: 0,
          supportsTools: reasoning ? 0 : 1, // R1 is reasoning-focused, not tool-use
          isFree: free ? 1 : 0,
          pricePrompt: null,
          priceCompletion: null,
          accessUrl: url.includes('api-docs') ? 'https://api-docs.deepseek.com' : 'https://chat.deepseek.com',
        });
      }
    }

    return models;
  }

  private isDeepSeekModelId(id: string): boolean {
    if (!id.startsWith('deepseek-')) return false;
    if (id.length < 12 || id.length > 40) return false;
    // Filter out non-model strings
    const exclusions = ['deepseek-api', 'deepseek-docs', 'deepseek-com', 'deepseek-www'];
    if (exclusions.includes(id)) return false;
    return true;
  }

  private buildModel(id: string, html: string, matchIndex: number, sourceUrl: string): CrawledModel {
    const nearby = html.slice(Math.max(0, matchIndex - 300), matchIndex + 500);
    const contextWindow = this.extractContextWindow(nearby, id);
    const caps = this.detectCapabilities(nearby);

    // Determine if free
    const isFree = id === 'deepseek-chat' || nearby.toLowerCase().includes('free');

    // Detect reasoning model
    const isReasoning = id.includes('reasoner') || nearby.toLowerCase().includes('reasoning');

    return {
      modelId: `deepseek/${id}`,
      harnessId: 'deepseek-crawl',
      planId: isFree ? 'free' : 'paid',
      medium: 'inference',
      contextWindow,
      supportsVision: caps.supportsVision,
      supportsTools: isReasoning ? 0 : 1,
      isFree: isFree ? 1 : 0,
      pricePrompt: null,
      priceCompletion: null,
      accessUrl: sourceUrl.includes('api-docs') ? 'https://api-docs.deepseek.com' : 'https://chat.deepseek.com',
    };
  }

  private extractFromJson(data: unknown, sourceUrl: string): CrawledModel[] {
    const models: CrawledModel[] = [];
    if (typeof data !== 'object' || data === null) return models;

    const obj = data as Record<string, unknown>;

    if (Array.isArray(data)) {
      for (const item of data) {
        models.push(...this.extractFromJson(item, sourceUrl));
      }
      return models;
    }

    // Check for DeepSeek model fields
    const idFields = ['id', 'model_id', 'modelId', 'name', 'slug', 'model'];
    for (const field of idFields) {
      const val = obj[field];
      if (typeof val === 'string' && val.toLowerCase().startsWith('deepseek-')) {
        const id = val.toLowerCase();
        models.push({
          modelId: `deepseek/${id}`,
          harnessId: 'deepseek-crawl',
          planId: id === 'deepseek-chat' ? 'free' : 'paid',
          medium: 'inference',
          contextWindow: typeof obj.context_window === 'number' ? obj.context_window
            : typeof obj.max_context === 'number' ? obj.max_context
            : 65_536,
          supportsVision: typeof obj.supports_vision === 'boolean' ? (obj.supports_vision ? 1 : 0) : 0,
          supportsTools: typeof obj.supports_tools === 'boolean' ? (obj.supports_tools ? 1 : 0) : 1,
          isFree: id === 'deepseek-chat' ? 1 : 0,
          pricePrompt: typeof obj.price_per_token === 'number' ? obj.price_per_token : null,
          priceCompletion: typeof obj.price_per_completion === 'number' ? obj.price_per_completion : null,
          accessUrl: sourceUrl.includes('api-docs') ? 'https://api-docs.deepseek.com' : 'https://chat.deepseek.com',
        });
        break;
      }
    }

    // Recurse
    for (const val of Object.values(obj)) {
      if (Array.isArray(val)) {
        for (const item of val) {
          models.push(...this.extractFromJson(item, sourceUrl));
        }
      } else if (typeof val === 'object' && val !== null) {
        models.push(...this.extractFromJson(val, sourceUrl));
      }
    }

    return models;
  }
}
