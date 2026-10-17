/**
 * Per-key free-tier caps — freellmapi's per-key usage tracking, adapted.
 *
 * The idea: a free-tier allowance belongs to an ACCOUNT, not to a user. Two
 * Groq keys mean two independent 1,000-requests-per-day pools, and one key
 * burning through its allowance says nothing about the other. freellmapi
 * knows usage because it proxies the traffic; ModelAPI does not proxy, so the
 * user (or their tooling) records usage per key, and /api/caps answers what is
 * actually left today — the number a recommender cannot guess.
 *
 * Keys are stored as platform + label only. No key material ever reaches this
 * service, which keeps the blast radius of a database leak at zero.
 */
import type { D1Database } from '@cloudflare/workers-types';
import { resolveQuota, type QuotaPool } from './quota';

export interface ApiKeyRow {
  key_id: string;
  user_id: string;
  platform: string;
  label: string;
  created_at: string;
  revoked_at: string | null;
}

export interface UsageRow {
  key_id: string;
  day: string;
  requests: number;
  tokens: number;
}

export interface KeyCap {
  keyId: string;
  platform: string;
  label: string;
  unit: string | null;
  allowance: number | null;
  usedRequests: number;
  usedTokens: number;
  /** Allowance minus the matching usage for today; null when there is no pool. */
  remaining: number | null;
  upgradeHint?: string;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Lowercase, trimmed platform id: matches the quota_pools.platform values. */
export function normalisePlatform(raw: string): string | null {
  const p = raw.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-_.]{0,63}$/.test(p) ? p : null;
}

/** UTC date — the window free tiers use. */
export function utcDay(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/** A usage counter: a non-negative integer up to a bounded ceiling. */
export function normaliseUsage(v: unknown): number | null {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1e9) return null;
  return Math.floor(n);
}

/**
 * One cap row per key. Pure: given the keys, all pools, today's usage rows and
 * the user's flags, it returns the math. Per platform the headline pool is the
 * one with the largest baseline allowance; the conditional tier still applies
 * through resolveQuota, so a paid-credits user sees the unlocked value.
 *
 * A pool measured in tokens is compared against recorded tokens; a pool
 * measured in requests (the normal free-tier unit) against recorded requests.
 */
export function capsFor(
  keys: ApiKeyRow[],
  pools: QuotaPool[],
  usage: UsageRow[],
  userFlags: Record<string, boolean> = {},
): KeyCap[] {
  const headline = new Map<string, QuotaPool>();
  for (const pool of pools) {
    const current = headline.get(pool.platform);
    if (!current || (pool.quota_value ?? -1) > (current.quota_value ?? -1)) {
      headline.set(pool.platform, pool);
    }
  }

  const usedByKey = new Map(usage.map((u) => [u.key_id, u]));
  return keys.map((k) => {
    const pool = headline.get(k.platform);
    const resolved = pool ? resolveQuota(pool, userFlags) : null;
    const u = usedByKey.get(k.key_id);
    const usedRequests = u?.requests ?? 0;
    const usedTokens = u?.tokens ?? 0;
    const tokenUnit = (resolved?.unit ?? '').includes('token');
    const used = tokenUnit ? usedTokens : usedRequests;
    const remaining =
      resolved?.value != null ? Math.max(0, resolved.value - used) : null;
    return {
      keyId: k.key_id,
      platform: k.platform,
      label: k.label,
      unit: resolved?.unit ?? null,
      allowance: resolved?.value ?? null,
      usedRequests,
      usedTokens,
      remaining,
      upgradeHint: resolved?.upgradeHint,
    };
  });
}

// ---------------------------------------------------------------------------
// D1 helpers
// ---------------------------------------------------------------------------

export async function createKey(
  db: D1Database,
  userId: string,
  platform: string,
  label = '',
): Promise<string> {
  const keyId = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO user_api_keys (key_id, user_id, platform, label, created_at, revoked_at)
       VALUES (?1, ?2, ?3, ?4, ?5, NULL)`,
    )
    .bind(keyId, userId, platform, label, new Date().toISOString())
    .run();
  return keyId;
}

export async function listKeys(db: D1Database, userId: string): Promise<ApiKeyRow[]> {
  const res = await db
    .prepare(
      `SELECT key_id, user_id, platform, label, created_at, revoked_at
         FROM user_api_keys WHERE user_id = ?1 AND revoked_at IS NULL
        ORDER BY created_at, key_id`,
    )
    .bind(userId)
    .all<ApiKeyRow>();
  return res.results ?? [];
}

/** Soft delete. Revoked keys keep their usage history for the record. */
export async function revokeKey(db: D1Database, userId: string, keyId: string): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE user_api_keys SET revoked_at = ?3
        WHERE key_id = ?1 AND user_id = ?2 AND revoked_at IS NULL`,
    )
    .bind(keyId, userId, new Date().toISOString())
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/**
 * Record usage against one of the user's own live keys. Returns false when
 * the key does not exist, belongs to someone else, or is revoked — the three
 * cases are deliberately indistinguishable to the caller.
 */
export async function recordUsage(
  db: D1Database,
  userId: string,
  keyId: string,
  requests: number,
  tokens: number,
  day: string = utcDay(),
): Promise<boolean> {
  const owned = await db
    .prepare(
      `SELECT key_id FROM user_api_keys
        WHERE key_id = ?1 AND user_id = ?2 AND revoked_at IS NULL`,
    )
    .bind(keyId, userId)
    .first<{ key_id: string }>();
  if (!owned) return false;

  await db
    .prepare(
      `INSERT INTO key_usage (key_id, day, requests, tokens, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(key_id, day) DO UPDATE SET
         requests = requests + excluded.requests,
         tokens = tokens + excluded.tokens,
         updated_at = excluded.updated_at`,
    )
    .bind(keyId, day, requests, tokens, new Date().toISOString())
    .run();
  return true;
}

/** Everything /api/caps needs, in one call. */
export async function userCaps(
  db: D1Database,
  userId: string,
  userFlags: Record<string, boolean> = {},
): Promise<KeyCap[]> {
  const keys = await listKeys(db, userId);
  if (keys.length === 0) return [];

  const pools = await db.prepare(`SELECT * FROM quota_pools`).all<QuotaPool>();
  const placeholders = keys.map((_, i) => `?${i + 2}`).join(',');
  const usage = await db
    .prepare(
      `SELECT key_id, day, requests, tokens FROM key_usage
        WHERE day = ?1 AND key_id IN (${placeholders})`,
    )
    .bind(utcDay(), ...keys.map((k) => k.key_id))
    .all<UsageRow>();

  return capsFor(keys, pools.results ?? [], usage.results ?? [], userFlags);
}
