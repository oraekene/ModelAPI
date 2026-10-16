/**
 * Groq Web Crawler — scrapes https://console.groq.com/docs/models
 *
 * Groq's docs page lists all available models with context windows,
 * rate limits, and capabilities. No API key needed.
 *
 * Enhanced with Scrapling-inspired resilient parsing:
 * - Multiple extraction strategies with fallbacks
 * - JSON-LD and embedded JSON detection
 * - Context window extraction from nearby text
 * - Capability detection from model names
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

    // Strategy 1: Extract from embedded JSON/Next.js data
    const jsonData = this.extractJsonFromScripts(html, /model|id|name/i);
    for (const data of jsonData) {
      const found = this.extractModelsFromJson(data);
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
      const found = this.extractModelsFromJson(data);
      for (const m of found) {
        if (!seen.has(m.modelId)) {
          seen.add(m.modelId);
          models.push(m);
        }
      }
    }

    // Strategy 3: Pattern matching on model IDs (Scrapling fallback chain)
    const modelPatterns = [
      // Groq model ID format: llama-3.3-70b-versatile
      /\b([a-z][a-z0-9]*(?:-[a-z0-9]+)+)\b/gi,
      // Code blocks with model references
      /<code[^>]*>([a-z][a-z0-9]*(?:-[a-z0-9]+)+)<\/code>/gi,
      // Table cells with model names
      /<td[^>]*>([a-z][a-z0-9]*(?:-[a-z0-9]+)+)<\/td>/gi,
    ];

    for (const pattern of modelPatterns) {
      let match;
      while ((match = pattern.exec(html)) !== null) {
        const raw = match[1].toLowerCase();
        if (seen.has(raw)) continue;
        if (this.isLikelyModelId(raw)) {
          seen.add(raw);
          models.push(this.buildModel(raw, html, match.index));
        }
      }
    }

    // Strategy 4: Known Groq models (always add these as fallback)
    const knownGroqModels = [
      { id: 'llama-3.3-70b-versatile', ctx: 128_000, vision: false },
      { id: 'llama-3.1-8b-instant', ctx: 131_072, vision: false },
      { id: 'llama-3.1-70b-versatile', ctx: 131_072, vision: false },
      { id: 'llama-3.2-1b-preview', ctx: 8_192, vision: false },
      { id: 'llama-3.2-3b-preview', ctx: 8_192, vision: false },
      { id: 'llama-3.2-11b-vision-preview', ctx: 8_192, vision: true },
      { id: 'llama-3.2-90b-vision-preview', ctx: 8_192, vision: true },
      { id: 'mixtral-8x7b-32768', ctx: 32_768, vision: false },
      { id: 'gemma2-9b-it', ctx: 8_192, vision: false },
      { id: 'gemma-7b-it', ctx: 8_192, vision: false },
      { id: 'phi-3-mini-128k-instruct', ctx: 131_072, vision: false },
      { id: 'qwen-qwq-32b', ctx: 32_768, vision: false },
    ];

    for (const { id, ctx, vision } of knownGroqModels) {
      if (!seen.has(id) && html.toLowerCase().includes(id)) {
        seen.add(id);
        models.push({
          modelId: `groq/${id}`,
          harnessId: 'groq-crawl',
          planId: 'free',
          medium: 'inference',
          contextWindow: ctx,
          supportsVision: vision ? 1 : 0,
          supportsTools: 1,
          isFree: 1,
          pricePrompt: null,
          priceCompletion: null,
          accessUrl: `https://console.groq.com/docs/models#${id}`,
        });
      }
    }

    return models;
  }

  private isLikelyModelId(id: string): boolean {
    // Filter out non-model strings
    const exclusions = ['http', 'api', 'docs', 'console', 'groq', 'com', 'www', 'blog', 'post', 'get', 'set', 'true', 'false'];
    if (exclusions.includes(id)) return false;
    if (id.length < 5 || id.length > 80) return false;
    // Must contain at least one number (model versions usually have numbers)
    if (!/\d/.test(id)) return false;
    // Must contain hyphens (Groq format)
    if (!id.includes('-')) return false;
    return true;
  }

  private buildModel(id: string, html: string, matchIndex: number): CrawledModel {
    // Extract context window from nearby text
    const nearby = html.slice(Math.max(0, matchIndex - 300), matchIndex + 500);
    const contextWindow = this.extractContextWindow(nearby, id);

    // Detect capabilities from name
    const caps = this.detectCapabilities(id);

    return {
      modelId: `groq/${id}`,
      harnessId: 'groq-crawl',
      planId: 'free',
      medium: 'inference',
      contextWindow,
      supportsVision: caps.supportsVision || (id.includes('vision') ? 1 : 0),
      supportsTools: 1,
      isFree: 1,
      pricePrompt: null,
      priceCompletion: null,
      accessUrl: `https://console.groq.com/docs/models#${id}`,
    };
  }

  private extractModelsFromJson(data: unknown): CrawledModel[] {
    const models: CrawledModel[] = [];
    if (typeof data !== 'object' || data === null) return models;

    const obj = data as Record<string, unknown>;

    // Look for model ID fields
    const idFields = ['id', 'model_id', 'modelId', 'name', 'slug'];
    for (const field of idFields) {
      const val = obj[field];
      if (typeof val === 'string' && this.isLikelyModelId(val.toLowerCase())) {
        models.push({
          modelId: `groq/${val.toLowerCase()}`,
          harnessId: 'groq-crawl',
          planId: 'free',
          medium: 'inference',
          contextWindow: typeof obj.context_window === 'number' ? obj.context_window : null,
          supportsVision: typeof obj.supports_vision === 'boolean' ? (obj.supports_vision ? 1 : 0) : 0,
          supportsTools: 1,
          isFree: 1,
          pricePrompt: null,
          priceCompletion: null,
          accessUrl: `https://console.groq.com/docs/models#${val.toLowerCase()}`,
        });
        break;
      }
    }

    // Recurse into nested objects
    for (const val of Object.values(obj)) {
      if (Array.isArray(val)) {
        for (const item of val) {
          models.push(...this.extractModelsFromJson(item));
        }
      } else if (typeof val === 'object' && val !== null) {
        models.push(...this.extractModelsFromJson(val));
      }
    }

    return models;
  }
}
