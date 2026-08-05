/**
 * Scraper Registry — central dispatch for the Universal Scraper Network.
 *
 * The producer calls `planMessages(runId)` to get all queue messages from
 * all registered scrapers. The consumer calls `handle(msg, env)` to dispatch
 * a message to the correct scraper by its `kind` field.
 *
 * Usage:
 *   const registry = new ScraperRegistry();
 *   registry.register(new GroqScraper());
 *   registry.register(new TogetherScraper());
 *
 *   // Producer:
 *   const messages = registry.planMessages(runId);
 *
 *   // Consumer:
 *   const result = await registry.handle(msg, env);
 */

import type {
  Scraper,
  ScraperMessage,
  ScraperResult,
  ScraperEnv,
  SourceHealth,
  ScraperCategory,
} from './types';
import { BaseScraper } from './base';
import { GroqScraper } from './groq';
import { TogetherScraper } from './together';

export {
  type Scraper,
  type ScraperMessage,
  type ScraperResult,
  type ScraperEnv,
  type SourceHealth,
  type ScraperCategory,
  BaseScraper,
  GroqScraper,
  TogetherScraper,
};

export class ScraperRegistry {
  private scrapers = new Map<string, Scraper>();
  private kindToScraper = new Map<string, Scraper>();

  /** Register a scraper. Overwrites any previous scraper with the same id. */
  register(scraper: Scraper): void {
    this.scrapers.set(scraper.id, scraper);
    // Each scraper's messages use `kind = scraper.id` by default.
    // If a scraper needs multiple message kinds, it overrides this.
    this.kindToScraper.set(scraper.id, scraper);
  }

  /** Unregister a scraper by id. */
  unregister(id: string): void {
    const scraper = this.scrapers.get(id);
    if (scraper) {
      this.scrapers.delete(id);
      this.kindToScraper.delete(scraper.id);
    }
  }

  /** Get a scraper by id. */
  get(id: string): Scraper | undefined {
    return this.scrapers.get(id);
  }

  /** Get all registered scrapers. */
  all(): Scraper[] {
    return Array.from(this.scrapers.values());
  }

  /** Get scrapers filtered by category. */
  byCategory(category: ScraperCategory): Scraper[] {
    return this.all().filter((s) => s.category === category);
  }

  /** Number of registered scrapers. */
  get size(): number {
    return this.scrapers.size;
  }

  /**
   * Plan all queue messages for a sync run.
   * Iterates every registered scraper and collects their messages.
   */
  planMessages(runId: string): ScraperMessage[] {
    const messages: ScraperMessage[] = [];
    for (const scraper of this.scrapers.values()) {
      messages.push(...scraper.planMessages(runId));
    }
    return messages;
  }

  /**
   * Dispatch a queue message to the correct scraper.
   * Looks up the scraper by `msg.kind`.
   * Throws if no scraper is registered for the given kind.
   */
  async handle(msg: ScraperMessage, env: ScraperEnv): Promise<ScraperResult> {
    const scraper = this.kindToScraper.get(msg.kind);
    if (!scraper) {
      throw new Error(`No scraper registered for kind "${msg.kind}"`);
    }
    return scraper.handle(msg, env);
  }

  /**
   * Check if a message kind is handled by a registered scraper.
   */
  canHandle(kind: string): boolean {
    return this.kindToScraper.has(kind);
  }

  /**
   * Return health status for all registered scrapers.
   */
  healthAll(): SourceHealth[] {
    return this.all().map((s) => s.health());
  }
}

/**
 * Create a ScraperRegistry with the given scrapers pre-registered.
 */
export function createRegistry(...scrapers: Scraper[]): ScraperRegistry {
  const registry = new ScraperRegistry();
  for (const scraper of scrapers) {
    registry.register(scraper);
  }
  return registry;
}
