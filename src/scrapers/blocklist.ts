/**
 * Scraper blocklist — prune dead sources mechanically (blueprint #43 pattern:
 * probe, block, expire).
 *
 * Rules:
 *   - A scraper whose health shows >= BLOCK_AFTER_FAILURES consecutive failures
 *     is blocked.
 *   - A blocked scraper is skipped by the cron and /admin/scrape.
 *   - The block expires after BLOCK_TTL_DAYS; the scraper runs once more, so
 *     adding a missing API key automatically revives it.
 *   - A re-probe that succeeds (last_status = ok) clears the block.
 *   - A re-probe that fails again refreshes expires_at (weekly re-probe).
 *
 * The decision rule is a pure function so the test mirror stays honest.
 */

import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';

export const BLOCK_AFTER_FAILURES = 3;
export const BLOCK_TTL_DAYS = 7;

export interface HealthRow {
  scraper_id: string;
  last_status: string;
  last_error: string | null;
  consecutive_failures: number;
}

export interface BlockedRow {
  scraper_id: string;
  blocked_at: string;
  reason: string | null;
  failures: number;
  expires_at: string;
}

export type BlockAction = 'block' | 'unblock' | 'refresh' | 'none';

/**
 * Decide what to do with one scraper, given its health row, its blocklist row
 * (or null) and the current time.
 */
export function decideBlockAction(
  health: HealthRow | undefined,
  blocked: Pick<BlockedRow, 'expires_at'> | null | undefined,
  now: Date,
): BlockAction {
  if (!health) return 'none';
  const failures = health.consecutive_failures ?? 0;
  const expired = blocked ? new Date(blocked.expires_at).getTime() <= now.getTime() : false;

  if (blocked) {
    // A run that went through (or was never failing) clears the block.
    if (health.last_status === 'ok' && failures === 0) return 'unblock';
    // It was re-probed (block expired) and failed again: extend the TTL.
    if (expired && failures >= BLOCK_AFTER_FAILURES) return 'refresh';
    return 'none';
  }
  return failures >= BLOCK_AFTER_FAILURES ? 'block' : 'none';
}

/** True while the block is still in force. Expired blocks let the scraper run again. */
export function isBlockedNow(blocked: Pick<BlockedRow, 'expires_at'> | null | undefined, now: Date): boolean {
  if (!blocked) return false;
  return new Date(blocked.expires_at).getTime() > now.getTime();
}

/**
 * Read scraper_health + scraper_blocklist and apply the rules.
 * Returns counts per action, for logging. Called before planning messages.
 */
export async function reconcileBlocklist(
  db: D1Database,
  now: Date = new Date(),
): Promise<Record<BlockAction, number>> {
  const health = await db
    .prepare(`SELECT scraper_id, last_status, last_error, consecutive_failures FROM scraper_health`)
    .all<HealthRow>();
  const blocked = await db
    .prepare(`SELECT scraper_id, blocked_at, reason, failures, expires_at FROM scraper_blocklist`)
    .all<BlockedRow>();

  const blockedById = new Map((blocked.results ?? []).map((r) => [r.scraper_id, r]));
  const counts: Record<BlockAction, number> = { block: 0, unblock: 0, refresh: 0, none: 0 };
  const statements: D1PreparedStatement[] = [];

  for (const h of health.results ?? []) {
    const b = blockedById.get(h.scraper_id) ?? null;
    const action = decideBlockAction(h, b, now);
    counts[action]++;
    if (action === 'block') {
      statements.push(
        db
          .prepare(
            `INSERT INTO scraper_blocklist (scraper_id, blocked_at, reason, failures, expires_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(scraper_id) DO UPDATE SET
               blocked_at = excluded.blocked_at,
               reason = excluded.reason,
               failures = excluded.failures,
               expires_at = excluded.expires_at`,
          )
          .bind(h.scraper_id, now.toISOString(), h.last_error, h.consecutive_failures, plusDays(now, BLOCK_TTL_DAYS)),
      );
    } else if (action === 'unblock') {
      statements.push(db.prepare(`DELETE FROM scraper_blocklist WHERE scraper_id = ?1`).bind(h.scraper_id));
    } else if (action === 'refresh') {
      statements.push(
        db
          .prepare(`UPDATE scraper_blocklist SET expires_at = ?2, failures = ?3, reason = ?4 WHERE scraper_id = ?1`)
          .bind(h.scraper_id, plusDays(now, BLOCK_TTL_DAYS), h.consecutive_failures, h.last_error),
      );
    }
  }

  if (statements.length > 0) await db.batch(statements);
  return counts;
}

/** IDs to skip right now: blocked and not yet expired. */
export async function loadBlockedIds(db: D1Database, now: Date = new Date()): Promise<Set<string>> {
  const { results } = await db
    .prepare(`SELECT scraper_id FROM scraper_blocklist WHERE expires_at > ?1`)
    .bind(now.toISOString())
    .all<{ scraper_id: string }>();
  return new Set((results ?? []).map((r) => r.scraper_id));
}

function plusDays(from: Date, days: number): string {
  return new Date(from.getTime() + days * 86_400_000).toISOString();
}
