/**
 * Fireworks AI Web Crawler — scrapes https://fireworks.ai/models
 *
 * Fireworks' model page lists available models with pricing.
 * No API key needed.
 *
 * Enhanced with Scrapling-inspired techniques:
 * - JSON extraction from embedded data
 * - Table parsing for model listings
 * - Model ID pattern matching with context extraction
 */

import { WebCrawlerScraper, type CrawledModel } from './web-crawler';

export class FireworksCrawler extends WebCrawlerScraper {
  readonly id = 'fireworks-crawl';
  readonly category = 'inference' as const;
  readonly displayName = 'Fireworks AI (Web Crawl)';

  protected crawlUrls(): string[] {
    return [
      'https://fireworks.ai/models',
      'https://docs.fireworks.ai/getting-started/quickstart',
    ];
  }

  protected parseHtml(url: string, html: string): CrawledModel[] {
    const models: CrawledModel[] = [];
    const seen = new Set<string>();

    // Strategy 1: Extract from embedded JSON/Next.js data
    const jsonData = this.extractJsonFromScripts(html, /model|fireworks|accounts/i);
    for (const data of jsonData) {
      const found = this.extractFromJson(data, url);
      for (const m of found) {
        if (!seen.has(m.modelId)) {
          seen.add(m.modelId);
          models.push(m);
        }
      }
    }

    // Strategy 2: Fireworks uses accounts/fireworks/models/<model-id> format
    const modelRegex = /accounts\/fireworks\/models\/([a-z0-9-]+)/gi;
    let match;
    while ((match = modelRegex.exec(html)) !== null) {
      const id = match[1];
      if (seen.has(id)) continue;
      seen.add(id);

      const nearby = html.slice(Math.max(0, match.index - 200), match.index + 500);
      const contextWindow = this.extractContextWindow(nearby, id);
      const caps = this.detectCapabilities(nearby);

      models.push({
        modelId: `fireworks/${id}`,
        harnessId: 'fireworks-crawl',
        planId: 'paid',
        medium: 'inference',
        contextWindow,
        supportsVision: caps.supportsVision,
        supportsTools: caps.supportsTools || 1,
        isFree: 0,
        pricePrompt: null,
        priceCompletion: null,
        accessUrl: 'https://fireworks.ai/models',
      });
    }

    // Strategy 3: Pattern matching for model names
    const namePatterns = [
      // Fireworks model naming: llama-v3p3-70b-instruct
      /\b([a-z][a-z0-9]*(?:-v\d+[a-z0-9]*)*(?:-[a-z0-9]+)+)\b/gi,
      // Model references in headings or code
      /<(?:h[1-6]|code)[^>]*>([A-Za-z][A-Za-z0-9._-]+(?:-[A-Za-z0-9._-]+)+)<\/(?:h[1-6]|code)>/gi,
    ];

    for (const pattern of namePatterns) {
      let match;
      while ((match = pattern.exec(html)) !== null) {
        const raw = match[1].toLowerCase();
        if (seen.has(raw)) continue;
        if (this.isFireworksModelId(raw)) {
          seen.add(raw);
          models.push(this.buildModel(raw, html, match.index));
        }
      }
    }

    // Strategy 4: Known Fireworks models (fallback)
    const knownModels = [
      { id: 'accounts/fireworks/models/llama-v3p3-70b-instruct', ctx: 131_072 },
      { id: 'accounts/fireworks/models/llama-v3p1-405b-instruct', ctx: 131_072 },
      { id: 'accounts/fireworks/models/llama-v3p1-70b-instruct', ctx: 131_072 },
      { id: 'accounts/fireworks/models/llama-v3p1-8b-instruct', ctx: 131_072 },
      { id: 'accounts/fireworks/models/mixtral-8x22b-instruct', ctx: 65_536 },
      { id: 'accounts/fireworks/models/qwen-72b-instruct', ctx: 32_768 },
      { id: 'accounts/fireworks/models/deepseek-v3', ctx: 65_536 },
      { id: 'accounts/fireworks/models/stable-diffusion-xl', ctx: null },
      { id: 'accounts/fireworks/models/whisper-v3', ctx: null },
    ];

    for (const { id, ctx } of knownModels) {
      const shortId = id.split('/').pop()!;
      if (!seen.has(shortId) && html.toLowerCase().includes(shortId.toLowerCase())) {
        seen.add(shortId);
        models.push({
          modelId: `fireworks/${shortId}`,
          harnessId: 'fireworks-crawl',
          planId: 'paid',
          medium: 'inference',
          contextWindow: ctx,
          supportsVision: shortId.includes('vision') ? 1 : 0,
          supportsTools: 1,
          isFree: 0,
          pricePrompt: null,
          priceCompletion: null,
          accessUrl: 'https://fireworks.ai/models',
        });
      }
    }

    return models;
  }

  private isFireworksModelId(id: string): boolean {
    // Fireworks uses version-style naming: v3p1, v3p3, etc.
    if (id.length < 5 || id.length > 60) return false;
    const exclusions = ['http', 'www', 'docs', 'api', 'models', 'blog', 'post', 'get', 'set'];
    if (exclusions.includes(id)) return false;
    // Must contain version-like pattern or be a known model family
    const modelFamilies = ['llama', 'mixtral', 'qwen', 'deepseek', 'stable', 'whisper', 'gemma'];
    if (!modelFamilies.some((f) => id.includes(f))) return false;
    return true;
  }

  private buildModel(id: string, html: string, matchIndex: number): CrawledModel {
    const nearby = html.slice(Math.max(0, matchIndex - 300), matchIndex + 500);
    const contextWindow = this.extractContextWindow(nearby, id);
    const caps = this.detectCapabilities(nearby);

    return {
      modelId: `fireworks/${id}`,
      harnessId: 'fireworks-crawl',
      planId: 'paid',
      medium: 'inference',
      contextWindow,
      supportsVision: caps.supportsVision,
      supportsTools: caps.supportsTools || 1,
      isFree: 0,
      pricePrompt: null,
      priceCompletion: null,
      accessUrl: 'https://fireworks.ai/models',
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

    // Check for model ID in various fields
    const idFields = ['id', 'model_id', 'modelId', 'name', 'slug', 'model', 'path'];
    for (const field of idFields) {
      const val = obj[field];
      if (typeof val === 'string') {
        // Check for Fireworks format
        if (val.includes('accounts/fireworks/models/')) {
          const id = val.split('/').pop()!;
          models.push({
            modelId: `fireworks/${id}`,
            harnessId: 'fireworks-crawl',
            planId: 'paid',
            medium: 'inference',
            contextWindow: typeof obj.context_window === 'number' ? obj.context_window : null,
            supportsVision: typeof obj.supports_vision === 'boolean' ? (obj.supports_vision ? 1 : 0) : 0,
            supportsTools: 1,
            isFree: 0,
            pricePrompt: typeof obj.price_per_token === 'number' ? obj.price_per_token : null,
            priceCompletion: typeof obj.price_per_completion === 'number' ? obj.price_per_completion : null,
            accessUrl: 'https://fireworks.ai/models',
          });
          break;
        }
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
