/**
 * SearXNG Integration — Metasearch discovery for AI platforms
 *
 * SearXNG is a privacy-respecting metasearch engine that can be
 * self-hosted or used via public instances. We use it to:
 *   1. Discover new AI platform pages and pricing docs
 *   2. Find model listings and documentation
 *   3. Track changes in platform offerings
 *
 * Uses public instances with fallback logic.
 * Self-hosting recommended for production use.
 */

import { AutoThrottle, smartFetch, buildHeaders } from './crawl-utils';

export interface SearxngResult {
  url: string;
  title: string;
  content: string;
  engines: string[];
  score?: number;
}

export interface SearxngResponse {
  results: SearxngResult[];
  suggestions: string[];
  number_of_results?: number;
}

// Public SearXNG instances (rotate for reliability)
const PUBLIC_INSTANCES = [
  'https://search.inetol.net',
  'https://searx.be',
  'https://search.ononoki.org',
  'https://searxng.ch',
  'https://search.bus-hit.me',
];

/**
 * SearXNG client for AI platform discovery.
 */
export class SearxngClient {
  private throttle = new AutoThrottle(1, 10, 1);
  private instances: string[];
  private currentInstance = 0;

  constructor(instances?: string[]) {
    this.instances = instances ?? PUBLIC_INSTANCES;
  }

  /**
   * Search for AI platform pages and model listings.
   */
  async search(query: string, options?: {
    categories?: string;
    language?: string;
    timeRange?: string;
    pageno?: number;
  }): Promise<SearxngResult[]> {
    const params = new URLSearchParams({
      q: query,
      format: 'json',
      categories: options?.categories ?? 'general',
      language: options?.language ?? 'en',
    });

    if (options?.timeRange) params.set('time_range', options.timeRange);
    if (options?.pageno) params.set('pageno', String(options.pageno));

    // Try each instance with fallback
    for (let i = 0; i < this.instances.length; i++) {
      const instanceIdx = (this.currentInstance + i) % this.instances.length;
      const instance = this.instances[instanceIdx];

      try {
        const url = `${instance}/search?${params.toString()}`;
        const result = await smartFetch(url, this.throttle, {
          maxRetries: 1,
          extraHeaders: { 'Accept': 'application/json' },
        });

        if (result.ok) {
          const data = JSON.parse(result.body) as SearxngResponse;
          this.currentInstance = instanceIdx; // Prefer working instance
          return data.results ?? [];
        }
      } catch {
        // Try next instance
      }
    }

    return [];
  }

  /**
   * Discover AI platform URLs for a specific provider.
   */
  async discoverPlatform(platform: string): Promise<SearxngResult[]> {
    const queries = [
      `${platform} AI models pricing`,
      `${platform} API documentation models`,
      `site:${this.getDomain(platform)} models`,
    ];

    const results: SearxngResult[] = [];
    for (const q of queries) {
      const found = await this.search(q);
      results.push(...found);
      // Rate limit between queries
      await new Promise((r) => setTimeout(r, 1000));
    }

    return results;
  }

  /**
   * Find pricing pages for AI platforms.
   */
  async findPricingPages(platforms: string[]): Promise<Map<string, SearxngResult[]>> {
    const results = new Map<string, SearxngResult[]>();

    for (const platform of platforms) {
      const query = `${platform} pricing tokens per million`;
      const found = await this.search(query);
      results.set(platform, found);
      await new Promise((r) => setTimeout(r, 1500));
    }

    return results;
  }

  /**
   * Track changes in AI model offerings.
   */
  async trackModelChanges(platform: string): Promise<{
    newModels: SearxngResult[];
    removedModels: SearxngResult[];
    updatedPricing: SearxngResult[];
  }> {
    // Search for recent announcements
    const recentQuery = `${platform} new model announcement`;
    const recentResults = await this.search(recentQuery, { timeRange: 'month' });

    // Filter for model-related results
    const newModels = recentResults.filter((r) =>
      /model|release|launch|available/i.test(r.title + r.content),
    );

    const updatedPricing = recentResults.filter((r) =>
      /pricing|price|cost|tokens/i.test(r.title + r.content),
    );

    return {
      newModels,
      removedModels: [], // Would need historical data to detect removals
      updatedPricing,
    };
  }

  private getDomain(platform: string): string {
    const domains: Record<string, string> = {
      openai: 'openai.com',
      anthropic: 'anthropic.com',
      google: 'ai.google.dev',
      meta: 'ai.meta.com',
      mistral: 'mistral.ai',
      groq: 'groq.com',
      together: 'together.ai',
      fireworks: 'fireworks.ai',
      deepseek: 'deepseek.com',
      cohere: 'cohere.com',
      huggingface: 'huggingface.co',
      perplexity: 'perplexity.ai',
      replication: 'replicate.com',
      fal: 'fal.ai',
      stability: 'stability.ai',
    };
    return domains[platform.toLowerCase()] ?? `${platform.toLowerCase()}.com`;
  }
}

/**
 * Predefined search queries for AI platform discovery.
 */
export const AI_PLATFORM_QUERIES = {
  inference: [
    'AI model inference API pricing 2024',
    'LLM API pricing comparison',
    'free AI model API endpoints',
    'serverless inference API',
  ],
  models: [
    'latest AI model releases',
    'open source LLM models',
    'multimodal AI models',
    'code generation AI models',
  ],
  pricing: [
    'AI model pricing per token',
    'LLM API cost comparison',
    'cheap AI inference API',
    'free tier AI API',
  ],
  docs: [
    'AI platform API documentation',
    'model catalog listing',
    'supported models list',
    'API reference models',
  ],
};

/**
 * Create a SearxngClient with default configuration.
 */
export function createSearxngClient(): SearxngClient {
  return new SearxngClient();
}
