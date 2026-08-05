/**
 * WebCrawlerScraper — base class for API-free web crawling.
 *
 * Instead of calling official APIs (which need keys), this scraper:
 *   1. Fetches public web pages (model catalogs, pricing pages)
 *   2. Parses HTML to extract structured model data
 *   3. Writes offerings to D1 just like API scrapers
 *
 * Subclasses implement:
 *   - crawlUrls() — list of URLs to fetch
 *   - parseHtml(url, html) — extract models from HTML
 */

import { BaseScraper } from './base';
import type { ScraperMessage, ScraperResult, ScraperEnv } from './types';

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
  /** URL to access the model */
  accessUrl: string;
}

const OFFERING_SQL = `INSERT INTO offerings (model_id, harness_id, plan_id, medium, context_window, supports_vision, supports_tools, is_free, price_prompt, price_completion, access_url, last_verified_at, score_key) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13) ON CONFLICT(model_id, harness_id, plan_id) DO UPDATE SET context_window=excluded.context_window, supports_vision=excluded.supports_vision, supports_tools=excluded.supports_tools, is_free=excluded.is_free, price_prompt=excluded.price_prompt, price_completion=excluded.price_completion, last_verified_at=excluded.last_verified_at, score_key=excluded.score_key`;

export abstract class WebCrawlerScraper extends BaseScraper {
  /**
   * Maximum number of concurrent fetches.
   * Override in subclasses if the platform rate-limits.
   */
  protected maxConcurrency = 3;

  /**
   * User-Agent header to use for requests.
   * Some sites block non-browser UAs.
   */
  protected userAgent = 'Mozilla/5.0 (compatible; ModelMap/1.0; +https://modelmap.dev)';

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

    // Fetch and parse each URL (with concurrency limit).
    for (let i = 0; i < urls.length; i += this.maxConcurrency) {
      const batch = urls.slice(i, i + this.maxConcurrency);
      const results = await Promise.allSettled(
        batch.map(async (url) => {
          const html = await this.fetchPage(url);
          return this.parseHtml(url, html);
        }),
      );
      for (const r of results) {
        if (r.status === 'fulfilled') allModels.push(...r.value);
      }
    }

    if (allModels.length === 0) {
      return { offerings: 0, scores: 0, quotas: 0, note: `${this.displayName}: no models found` };
    }

    // Write to D1.
    const now = new Date().toISOString();
    const stmt = env.DB.prepare(OFFERING_SQL);
    const rows = allModels.map((m) =>
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
        m.accessUrl,
        now,
        m.modelId.split('/')[1] ?? m.modelId,
      ),
    );

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
   * Fetch a page with retry and rate-limit handling.
   */
  protected async fetchPage(url: string, retries = 2): Promise<string> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(url, {
          headers: {
            'User-Agent': this.userAgent,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
          },
          redirect: 'follow',
        });

        if (res.status === 429) {
          // Rate limited — wait and retry.
          const retryAfter = Number(res.headers.get('Retry-After') ?? '5');
          await new Promise((r) => setTimeout(r, retryAfter * 1000));
          continue;
        }

        if (!res.ok) {
          throw new Error(`HTTP ${res.status} for ${url}`);
        }

        return await res.text();
      } catch (err) {
        if (attempt === retries) throw err;
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
    throw new Error(`Failed to fetch ${url} after ${retries + 1} attempts`);
  }

  // -----------------------------------------------------------------------
  // HTML parsing utilities
  // -----------------------------------------------------------------------

  /**
   * Extract text content from an HTML string (strip tags).
   */
  protected stripTags(html: string): string {
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  /**
   * Extract content between two markers.
   * Case-insensitive, supports regex patterns.
   */
  protected extractBetween(html: string, start: string | RegExp, end: string | RegExp): string {
    const startMatch = typeof start === 'string'
      ? html.indexOf(start)
      : html.search(start);
    if (startMatch === -1) return '';
    const from = typeof start === 'string' ? startMatch + start.length : startMatch;
    const endMatch = typeof end === 'string'
      ? html.indexOf(end, from)
      : html.slice(from).search(end);
    if (endMatch === -1) return html.slice(from);
    return html.slice(from, from + endMatch);
  }

  /**
   * Find all JSON-LD structured data in the page.
   * Many sites embed model info as JSON-LD.
   */
  protected extractJsonLd(html: string): unknown[] {
    const results: unknown[] = [];
    const regex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    while ((match = regex.exec(html)) !== null) {
      try {
        results.push(JSON.parse(match[1]));
      } catch { /* skip malformed JSON-LD */ }
    }
    return results;
  }

  /**
   * Find all JSON objects in the page that match a key pattern.
   * Useful for finding model data embedded in Next.js/React pages.
   */
  protected extractJsonByPattern(html: string, keyPattern: RegExp): unknown[] {
    const results: unknown[] = [];
    // Match JSON objects in <script> tags (Next.js __NEXT_DATA__, etc.)
    const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
    let scriptMatch;
    while ((scriptMatch = scriptRegex.exec(html)) !== null) {
      const content = scriptMatch[1];
      if (keyPattern.test(content)) {
        // Try to extract JSON objects from the script content.
        const jsonRegex = /(\{[\s\S]*?\})\s*[;,]/g;
        let jsonMatch;
        while ((jsonMatch = jsonRegex.exec(content)) !== null) {
          try {
            const obj = JSON.parse(jsonMatch[1]);
            if (typeof obj === 'object' && obj !== null) {
              results.push(obj);
            }
          } catch { /* not valid JSON */ }
        }
      }
    }
    return results;
  }

  /**
   * Parse a price string like "$0.50/1M tokens" or "€1.20 per million".
   * Returns price per token, or null if unparseable.
   */
  protected parsePricePerToken(priceStr: string): number | null {
    if (!priceStr) return null;
    const normalized = priceStr.toLowerCase().replace(/[,\s]/g, '');

    // Match patterns like "$0.50/1m", "$0.50 per million", "0.50/1M tokens"
    const match = normalized.match(/\$?([\d.]+)\s*\/?\s*(?:per\s+)?(\d+[km]?)\s*(?:tokens?|input|output)?/);
    if (!match) return null;

    const price = parseFloat(match[1]);
    if (isNaN(price)) return null;

    let divisor = 1_000_000; // default: per million
    const unit = match[2];
    if (unit.endsWith('k')) {
      divisor = 1_000;
    } else if (!unit.includes('m') && !unit.includes('million')) {
      // Might be a flat price or per-token
      divisor = 1;
    }

    return price / divisor;
  }
}
