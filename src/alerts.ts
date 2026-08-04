/**
 * Alerts — step 9.
 *
 * Fires when the #1 offering for a (category, tier) changes AND the margin
 * exceeds the user's threshold. The margin gate is what makes this bearable:
 * without it, two near-tied models trade places on every sync and the bot
 * becomes noise the user mutes — at which point the feature is worse than not
 * shipping it.
 */

import { detectRankOneChange, type Tier } from './ranking';
import { sendMessage } from './telegram';

export interface AlertEnv {
  DB: D1Database;
  CACHE: KVNamespace;
  TELEGRAM_BOT_TOKEN?: string;
}

/** Suppression window: never alert twice for the same route inside this. */
const COOLDOWN_HOURS = 12;

export interface AlertResult {
  sent: number;
  suppressed: string[];
}

export async function maybeAlert(
  env: AlertEnv,
  category: string,
  tier: Tier,
): Promise<AlertResult> {
  const result: AlertResult = { sent: 0, suppressed: [] };
  if (!env.TELEGRAM_BOT_TOKEN) return result;

  const { results: subs } = await env.DB.prepare(
    `SELECT user_id, telegram_chat_id, alert_threshold_pct
       FROM user_preferences
      WHERE alerts_enabled = 1 AND telegram_chat_id IS NOT NULL`,
  ).all<{ user_id: string; telegram_chat_id: string; alert_threshold_pct: number }>();

  if (!subs || subs.length === 0) return result;

  for (const sub of subs) {
    const change = await detectRankOneChange(env.DB, category, tier, sub.alert_threshold_pct ?? 3);
    if (!change.changed) continue;

    // Cooldown, keyed per user AND route, so a flapping category cannot spam.
    const key = `alert-sent:${sub.user_id}:${category}:${tier}`;
    const last = await env.CACHE.get(key);
    if (last && Date.now() - Number(last) < COOLDOWN_HOURS * 3_600_000) {
      result.suppressed.push(`${category}/${tier} (cooldown)`);
      continue;
    }

    const direction = (change.margin ?? 0) > 0 ? '↑' : '↓';
    const text = [
      `<b>New #1 — ${category.replace(/_/g, ' ')} (${tier})</b>`,
      '',
      `${change.current}`,
      `was: ${change.previous}`,
      `margin: ${direction} ${Math.abs(change.margin ?? 0)}%`,
    ].join('\n');

    await sendMessage(env.TELEGRAM_BOT_TOKEN, sub.telegram_chat_id, text);
    await env.CACHE.put(key, String(Date.now()), { expirationTtl: COOLDOWN_HOURS * 3600 });
    result.sent++;
  }

  return result;
}
