/**
 * Together AI Web Crawler — scrapes https://www.together.ai/models
 * and https://docs.together.ai/docs/serverless-models
 *
 * Together's model pages list available models with pricing.
 * No API key needed.
 *
 * Enhanced with Scrapling-inspired techniques:
 * - JSON extraction from embedded data
 * - Table parsing for pricing info
 * - Model ID pattern matching with fallbacks
 */

import { WebCrawlerScraper, type CrawledModel } from './web-crawler';

export class TogetherCrawler extends WebCrawlerScraper {
  readonly id = 'together-crawl';
  readonly category = 'inference' as const;
  readonly displayName = 'Together AI (Web Crawl)';

  protected crawlUrls(): string[] {
    return [
      'https://www.together.ai/models',
      'https://docs.together.ai/docs/serverless-models',
    ];
  }

  protected parseHtml(url: string, html: string): CrawledModel[] {
    const models: CrawledModel[] = [];
    const seen = new Set<string>();

    // Strategy 1: Extract from embedded JSON/Next.js data
    const jsonData = this.extractJsonFromScripts(html, /model|pricing|serverless/i);
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

    // Strategy 3: Pattern matching for Together model format
    // Together uses: org/model-name (e.g., meta-llama/Llama-3.3-70B-Instruct-Turbo)
    const modelPatterns = [
      // Together model ID format: org/model-name
      /\b([a-z][a-z0-9-]*\/[A-Za-z][A-Za-z0-9._-]+)\b/g,
      // Model references in table cells
      /<td[^>]*>([A-Z][A-Za-z0-9._-]+(?:-[A-Za-z0-9._-]+)+)<\/td>/g,
      // Model names in headings
      /<h[2-4][^>]*>([^<]*(?:Llama|Qwen|Mistral|DeepSeek|Gemma|Phi|DBRX)[^<]*)<\/h[2-4]>/gi,
    ];

    for (const pattern of modelPatterns) {
      let match;
      while ((match = pattern.exec(html)) !== null) {
        const raw = match[1];
        if (seen.has(raw)) continue;
        if (this.isTogetherModelId(raw)) {
          seen.add(raw);
          models.push(this.buildModel(raw, html, match.index, url));
        }
      }
    }

    // Strategy 4: Known Together models (always add as fallback)
    const knownModels = [
      { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', ctx: 131_072 },
      { id: 'meta-llama/Llama-3.1-405B-Instruct-Turbo', ctx: 131_072 },
      { id: 'meta-llama/Llama-3.1-70B-Instruct-Turbo', ctx: 131_072 },
      { id: 'meta-llama/Llama-3.1-8B-Instruct-Turbo', ctx: 131_072 },
      { id: 'Qwen/Qwen2.5-72B-Instruct-Turbo', ctx: 32_768 },
      { id: 'Qwen/Qwen2.5-32B-Instruct-Turbo', ctx: 32_768 },
      { id: 'Qwen/Qwen2.5-Coder-32B-Instruct', ctx: 32_768 },
      { id: 'deepseek-ai/DeepSeek-V3', ctx: 65_536 },
      { id: 'deepseek-ai/DeepSeek-R1', ctx: 65_536 },
      { id: 'mistralai/Mistral-Small-24B-Instruct-2501', ctx: 32_768 },
      { id: 'mistralai/Mixtral-8x22B-Instruct-v0.1', ctx: 65_536 },
      { id: 'google/gemma-2-27b-it', ctx: 8_192 },
      { id: 'databricks/dbrx-instruct-preview', ctx: 32_768 },
      { id: 'NousResearch/Nous-Hermes-2-Yi-34B', ctx: 200_000 },
    ];

    for (const { id, ctx } of knownModels) {
      if (!seen.has(id) && html.toLowerCase().includes(id.toLowerCase())) {
        seen.add(id);
        models.push({
          modelId: `together/${id}`,
          harnessId: 'together-crawl',
          planId: 'paid',
          medium: 'inference',
          contextWindow: ctx,
          supportsVision: id.toLowerCase().includes('vision') ? 1 : 0,
          supportsTools: 1,
          isFree: 0,
          pricePrompt: null,
          priceCompletion: null,
          accessUrl: `https://www.together.ai/models`,
        });
      }
    }

    return models;
  }

  private isTogetherModelId(id: string): boolean {
    // Together format: org/model-name
    if (!id.includes('/')) return false;
    const [org, model] = id.split('/');
    if (!org || !model) return false;
    if (org.length < 2 || model.length < 3) return false;
    // Filter out URLs and non-model paths
    const exclusions = ['http', 'www', 'docs', 'api', 'models', 'blog', 'post'];
    if (exclusions.includes(org.toLowerCase())) return false;
    return true;
  }

  private buildModel(id: string, html: string, matchIndex: number, sourceUrl: string): CrawledModel {
    const nearby = html.slice(Math.max(0, matchIndex - 300), matchIndex + 500);
    const contextWindow = this.extractContextWindow(nearby, id);
    const caps = this.detectCapabilities(nearby);

    // Try to extract pricing
    const priceMatch = nearby.match(/\$?([\d.]+)\s*\/?\s*(?:per\s+)?(\d+[km]?)\s*(?:tokens?)?/i);
    let pricePerToken: number | null = null;
    if (priceMatch) {
      pricePerToken = this.parsePricePerToken(priceMatch[0]);
    }

    const isFree = pricePerToken === null || pricePerToken === 0;

    return {
      modelId: `together/${id}`,
      harnessId: 'together-crawl',
      planId: isFree ? 'free' : 'paid',
      medium: 'inference',
      contextWindow,
      supportsVision: caps.supportsVision,
      supportsTools: caps.supportsTools || 1,
      isFree: isFree ? 1 : 0,
      pricePrompt: pricePerToken,
      priceCompletion: pricePerToken ? pricePerToken * 2 : null,
      accessUrl: sourceUrl.includes('docs') ? 'https://docs.together.ai' : 'https://www.together.ai/models',
    };
  }

  private extractFromJson(data: unknown, sourceUrl: string): CrawledModel[] {
    const models: CrawledModel[] = [];
    if (typeof data !== 'object' || data === null) return models;

    const obj = data as Record<string, unknown>;

    // Look for model arrays
    if (Array.isArray(data)) {
      for (const item of data) {
        models.push(...this.extractFromJson(item, sourceUrl));
      }
      return models;
    }

    // Check if this object looks like a model
    const idFields = ['id', 'model_id', 'modelId', 'name', 'slug', 'model'];
    for (const field of idFields) {
      const val = obj[field];
      if (typeof val === 'string' && this.isTogetherModelId(val)) {
        const ctx = typeof obj.context_window === 'number' ? obj.context_window
          : typeof obj.max_context === 'number' ? obj.max_context
          : null;

        models.push({
          modelId: `together/${val}`,
          harnessId: 'together-crawl',
          planId: 'paid',
          medium: 'inference',
          contextWindow: ctx,
          supportsVision: typeof obj.supports_vision === 'boolean' ? (obj.supports_vision ? 1 : 0) : 0,
          supportsTools: 1,
          isFree: 0,
          pricePrompt: typeof obj.price_per_token === 'number' ? obj.price_per_token : null,
          priceCompletion: typeof obj.price_per_completion === 'number' ? obj.price_per_completion : null,
          accessUrl: sourceUrl.includes('docs') ? 'https://docs.together.ai' : 'https://www.together.ai/models',
        });
        break;
      }
    }

    // Recurse into nested objects
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
