/**
 * BaseScraper — abstract base class for all scrapers.
 *
 * Provides common utilities:
 *   - Health tracking (updateHealth writes to D1 scraper_health table)
 *   - In-memory health state
 *   - Default planMessages/handle/health implementations
 *
 * Subclasses must implement:
 *   - id, category, displayName
 *   - doHandle(msg, env) — the actual scraping logic
 */

import type {
  Scraper,
  ScraperMessage,
  ScraperResult,
  ScraperEnv,
  SourceHealth,
  ScraperCategory,
} from './types';

export abstract class BaseScraper implements Scraper {
  abstract readonly id: string;
  abstract readonly category: ScraperCategory;
  abstract readonly displayName: string;

  /** In-memory health state. Persisted to D1 after each handle() call. */
  protected _health: SourceHealth = {
    scraperId: '',
    lastRunAt: null,
    lastStatus: 'never_run',
    lastError: null,
    consecutiveFailures: 0,
    modelsFound: 0,
    scoresWritten: 0,
  };

  /**
   * Ensure health.scraperId matches this.id.
   * Called lazily on first health access to avoid abstract property access
   * in the constructor.
   */
  private _ensureHealthId(): void {
    if (this._health.scraperId !== this.id) {
      this._health.scraperId = this.id;
    }
  }

  // -----------------------------------------------------------------------
  // Interface implementations
  // -----------------------------------------------------------------------

  /**
   * Default: one message per run with kind = scraper id.
   * Subclasses can override for multi-message scrapers.
   */
  planMessages(runId: string): ScraperMessage[] {
    return [{ kind: this.id, runId, payload: {} }];
  }

  /**
   * Handle a queue message. Calls doHandle() then updates health.
   * Do NOT override — override doHandle() instead.
   */
  async handle(msg: ScraperMessage, env: ScraperEnv): Promise<ScraperResult> {
    const startedAt = Date.now();
    try {
      const result = await this.doHandle(msg, env);
      this._health.lastRunAt = new Date().toISOString();
      this._health.lastStatus = 'ok';
      this._health.lastError = null;
      this._health.consecutiveFailures = 0;
      this._health.modelsFound += result.offerings;
      this._health.scoresWritten += result.scores;
      await this.updateHealth(env.DB);
      return result;
    } catch (err) {
      const elapsed = Date.now() - startedAt;
      this._health.lastRunAt = new Date().toISOString();
      this._health.lastStatus = elapsed > 30_000 ? 'timeout' : 'error';
      this._health.lastError = err instanceof Error ? err.message : String(err);
      this._health.consecutiveFailures += 1;
      await this.updateHealth(env.DB);
      throw err;
    }
  }

  /** Return the current in-memory health state. */
  health(): SourceHealth {
    this._ensureHealthId();
    return { ...this._health };
  }

  // -----------------------------------------------------------------------
  // Subclass hook
  // -----------------------------------------------------------------------

  /**
   * Implement the actual scraping logic here.
   * Return a ScraperResult with counts of what was written.
   */
  protected abstract doHandle(msg: ScraperMessage, env: ScraperEnv): Promise<ScraperResult>;

  // -----------------------------------------------------------------------
  // Health persistence
  // -----------------------------------------------------------------------

  /**
   * Write the current health state to D1.
   * Uses UPSERT so first run creates, subsequent runs update.
   */
  protected async updateHealth(db: D1Database): Promise<void> {
    await db
      .prepare(
        `INSERT INTO scraper_health (scraper_id, last_run_at, last_status, last_error,
                                     consecutive_failures, models_found, scores_written)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(scraper_id) DO UPDATE SET
           last_run_at = excluded.last_run_at,
           last_status = excluded.last_status,
           last_error = excluded.last_error,
           consecutive_failures = excluded.consecutive_failures,
           models_found = excluded.models_found,
           scores_written = excluded.scores_written`,
      )
      .bind(
        this._health.scraperId,
        this._health.lastRunAt,
        this._health.lastStatus,
        this._health.lastError,
        this._health.consecutiveFailures,
        this._health.modelsFound,
        this._health.scoresWritten,
      )
      .run();
  }

  /**
   * Load health state from D1 (e.g. on startup or after a cold restart).
   * Merges with in-memory state, preferring D1 values for counters.
   */
  protected async loadHealth(db: D1Database): Promise<void> {
    const row = await db
      .prepare(
        `SELECT last_run_at, last_status, last_error, consecutive_failures,
                models_found, scores_written
         FROM scraper_health WHERE scraper_id = ?1`,
      )
      .bind(this.id)
      .first<{
        last_run_at: string | null;
        last_status: string;
        last_error: string | null;
        consecutive_failures: number;
        models_found: number;
        scores_written: number;
      }>();

    if (row) {
      this._health.lastRunAt = row.last_run_at;
      this._health.lastStatus = row.last_status as SourceHealth['lastStatus'];
      this._health.lastError = row.last_error;
      this._health.consecutiveFailures = row.consecutive_failures;
      this._health.modelsFound = row.models_found;
      this._health.scoresWritten = row.scores_written;
    }
  }
}
