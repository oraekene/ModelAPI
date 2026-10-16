/**
 * WebCrawlerScraper — base class for API-free web crawling.
 *
 * Enhanced with techniques borrowed from Scrapling, Camoufox, and QMD:
 * - Browser-realistic header profiles (Camoufox consistency)
 * - AutoThrottle with latency-based delays (Scrapling)
 * - Retry-After handling and block detection (Scrapling)
 * - Content hashing for dedup (QMD)
 * - Resilient parsing with fallback chains (Scrapling)
 * - robots.txt compliance
 * - Request timing jitter
 *
 * Subclasses implement:
 *   - crawlUrls() — list of URLs to fetch
 *   - parseHtml(url, html) — extract models from HTML
 */

import { BaseScraper } from './base';
import type { ScraperMessage, ScraperResult, ScraperEnv } from './types';
import {
  AutoThrottle,
  smartFetch,
  contentHash,
  extractJsonFromScripts,
  extractJsonLd,
  findModelJsonArrays,
  extractText,
  extractContextWindow,
  detectCapabilities,
  parsePricePerToken,
  normalizeUrl,
} from './crawl-utils';

export interface CrawledModel {
  /** Platform-prefixed model ID, e.g. "groq/llama-3.3-70b-versatile" */
  modelId: string;
  /** Harness ID, e.g. "groq-api" */
  harnessId: string;
  /** "free" or "paid" */
  planId: string;
  /** "inference", "tool", etc. */
  medium: string;
  /** Context window in tokens, null if unknown */
  contextWindow: number | null;
  /** 1 if supports vision */
  supportsVision: number;
  /** 1 if supports tool use */
  supportsTools: number;
  /** 1 if free */
  isFree: number;
  /** Price per token (prompt), null if unknown */
  pricePrompt: number | null;
  /** Price per token (completion), null if unknown */
  priceCompletion: number | null;
  /** Price per cached-input token, null if unknown */
  priceCacheRead?: number | null;
  /** URL to access the model */
  accessUrl: string;
  /**
   * Benchmark/usage join key. Defaults to the second path segment of modelId
   * (e.g. "groq/llama-3.3-70b" -> "llama-3.3-70b"). Override when the model ID
   * has more segments than provider/model.
   */
  scoreKey?: string;
}

export const OFFERING_SQL = `INSERT INTO offerings (model_id, harness_id, plan_id, medium, context_window, supports_vision, supports_tools, is_free, price_prompt, price_completion, price_cache_read, access_url, last_verified_at, score_key) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14) ON CONFLICT(model_id, harness_id, plan_id) DO UPDATE SET context_window=excluded.context_window, supports_vision=excluded.supports_vision, supports_tools=excluded.supports_tools, is_free=excluded.is_free, price_prompt=excluded.price_prompt, price_completion=excluded.price_completion, price_cache_read=excluded.price_cache_read, last_verified_at=excluded.last_verified_at, score_key=excluded.score_key`;

/** Bind one prepared statement per model. Shared by all crawlers that write offerings. */
export function offeringStatements(env: ScraperEnv, models: CrawledModel[], now: string) {
  const stmt = env.DB.prepare(OFFERING_SQL);
  return models.map((m) =>
    stmt.bind(
      m.modelId,
      m.harnessId,
      m.planId,
      m.medium,
      m.contextWindow,
      m.supportsVision,
      m.supportsTools,
      m.isFree,
      m.pricePrompt,
      m.priceCompletion,
      m.priceCacheRead ?? null,
      m.accessUrl,
      now,
      m.scoreKey ?? m.modelId.split('/')[1] ?? m.modelId,
    ),
  );
}

export abstract class WebCrawlerScraper extends BaseScraper {
  /**
   * Maximum number of concurrent fetches.
   * Override in subclasses if the platform rate-limits.
   */
  protected maxConcurrency = 3;

  /**
   * Shared throttle instance for rate limiting.
   * Subclasses can override startDelay/maxDelay.
   */
  protected throttle = new AutoThrottle(2, 30, this.maxConcurrency);

  /**
   * Content hashes seen this run (for dedup).
   */
  protected seenHashes = new Set<string>();

  // -----------------------------------------------------------------------
  // Subclass hooks
  // -----------------------------------------------------------------------

  /**
   * Return the URLs to crawl.
   * Called once per handle() invocation.
   */
  protected abstract crawlUrls(): string[];

  /**
   * Parse HTML from a URL and return extracted models.
   * Called once per URL returned by crawlUrls().
   *
   * @param url The URL that was fetched
   * @param html The raw HTML response
   * @returns Array of extracted models
   */
  protected abstract parseHtml(url: string, html: string): CrawledModel[];

  // -----------------------------------------------------------------------
  // Implementation
  // -----------------------------------------------------------------------

  protected async doHandle(_msg: ScraperMessage, env: ScraperEnv): Promise<ScraperResult> {
    const urls = this.crawlUrls();
    const allModels: CrawledModel[] = [];
    this.seenHashes.clear();

    // Fetch and parse each URL (with concurrency limit).
    for (let i = 0; i < urls.length; i += this.maxConcurrency) {
      const batch = urls.slice(i, i + this.maxConcurrency);
      const results = await Promise.allSettled(
        batch.map(async (url) => {
          const result = await smartFetch(url, this.throttle);
          if (!result.ok) {
            console.warn(`${this.displayName}: fetch failed for ${url}: ${result.status}`);
            return [];
          }
          if (result.blocked) {
            console.warn(`${this.displayName}: blocked by ${url}`);
            return [];
          }
          return this.parseHtml(url, result.body);
        }),
      );
      for (const r of results) {
        if (r.status === 'fulfilled') allModels.push(...r.value);
      }
    }

    // Dedup by content hash
    const uniqueModels = this.dedupModels(allModels);

    if (uniqueModels.length === 0) {
      return { offerings: 0, scores: 0, quotas: 0, note: `${this.displayName}: no models found` };
    }

    // Write to D1.
    const rows = offeringStatements(env, uniqueModels, new Date().toISOString());

    // Batch in groups of 50 to stay under D1 limits.
    for (let i = 0; i < rows.length; i += 50) {
      await env.DB.batch(rows.slice(i, i + 50));
    }

    return {
      offerings: rows.length,
      scores: 0,
      quotas: 0,
      note: `${rows.length} models from ${this.displayName} (web crawl)`,
    };
  }

  /**
   * Dedup models by content hash (QMD pattern).
   */
  protected dedupModels(models: CrawledModel[]): CrawledModel[] {
    const unique: CrawledModel[] = [];
    for (const m of models) {
      const hash = contentHash(`${m.modelId}:${m.planId}:${m.medium}`);
      if (!this.seenHashes.has(hash)) {
        this.seenHashes.add(hash);
        unique.push(m);
      }
    }
    return unique;
  }

  // -----------------------------------------------------------------------
  // Enhanced parsing utilities (borrowed from Scrapling/QMD)
  // -----------------------------------------------------------------------

  /**
   * Find model objects in embedded JSON arrays (React/Next.js pages).
   * Scrapling pattern: look for arrays with model-like objects.
   */
  protected findModelJsonArrays(html: string): Record<string, unknown>[][] {
    return findModelJsonArrays(html);
  }

  /**
   * Extract JSON from script tags.
   */
  protected extractJsonFromScripts(html: string, keyPattern?: RegExp): unknown[] {
    return extractJsonFromScripts(html, keyPattern);
  }

  /**
   * Extract JSON-LD structured data.
   */
  protected extractJsonLd(html: string): unknown[] {
    return extractJsonLd(html);
  }

  /**
   * Extract all visible text from HTML.
   */
  protected extractText(html: string): string {
    return extractText(html);
  }

  /**
   * Extract context window from text near a model name.
   */
  protected extractContextWindow(text: string, modelName: string): number | null {
    return extractContextWindow(text, modelName);
  }

  /**
   * Detect model capabilities from text.
   */
  protected detectCapabilities(text: string): {
    supportsVision: number;
    supportsTools: number;
    isFree: number;
  } {
    return detectCapabilities(text);
  }

  /**
   * Parse price per token.
   */
  protected parsePricePerToken(priceStr: string): number | null {
    return parsePricePerToken(priceStr);
  }

  /**
   * Normalize URL for dedup.
   */
  protected normalizeUrl(url: string): string {
    return normalizeUrl(url);
  }
}
