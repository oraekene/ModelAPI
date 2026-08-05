/**
 * Scraper types — shared vocabulary for the Universal Scraper Network.
 *
 * Every scraper implements the Scraper interface and registers itself in the
 * ScraperRegistry. The producer iterates the registry to plan messages; the
 * consumer looks up the handler dynamically.
 */

import type { D1Database } from '@cloudflare/workers-types';

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export type ScraperCategory = 'inference' | 'lab' | 'ide' | 'harness' | 'tool' | 'agent';

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/**
 * Generic queue message. Each scraper defines its own payload shape via
 * `ScraperMessage<T>`. The queue carries `ScraperMessage<unknown>`; the
 * handler casts to the concrete type.
 */
export interface ScraperMessage<T = unknown> {
  kind: string;
  runId: string;
  payload: T;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface ScraperResult {
  /** Number of offerings upserted. */
  offerings: number;
  /** Number of scores upserted. */
  scores: number;
  /** Number of quota pool rows upserted. */
  quotas: number;
  /** Free-text note for logging. */
  note?: string;
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export type SourceStatus = 'ok' | 'error' | 'timeout' | 'never_run';

export interface SourceHealth {
  scraperId: string;
  lastRunAt: string | null;
  lastStatus: SourceStatus;
  lastError: string | null;
  consecutiveFailures: number;
  modelsFound: number;
  scoresWritten: number;
}

// ---------------------------------------------------------------------------
// Scraper interface
// ---------------------------------------------------------------------------

/**
 * The contract every scraper must implement.
 *
 * Lifecycle:
 *   1. Producer calls `planMessages(runId)` -> returns queue messages.
 *   2. Consumer calls `handle(msg, env)` for each message.
 *   3. `health()` returns the current health state for dashboards.
 */
export interface Scraper {
  /** Unique identifier, e.g. "groq", "together", "cursor". */
  id: string;
  /** Which category this scraper belongs to. */
  category: ScraperCategory;
  /** Human-readable name, e.g. "Groq", "Together AI". */
  displayName: string;

  /**
   * Plan what queue messages to emit for a sync run.
   * Called once per run by the producer.
   */
  planMessages(runId: string): ScraperMessage[];

  /**
   * Handle one queue message. Called by the consumer.
   * Must be idempotent — re-running with the same message is safe.
   */
  handle(msg: ScraperMessage, env: ScraperEnv): Promise<ScraperResult>;

  /** Return the current health state. */
  health(): SourceHealth;
}

// ---------------------------------------------------------------------------
// Environment (subset of Cloudflare Worker env bindings)
// ---------------------------------------------------------------------------

export interface ScraperEnv {
  DB: D1Database;
  CACHE: KVNamespace;
  /** API keys, secrets, etc. — scrapers read what they need. */
  [key: string]: unknown;
}
