/**
 * Telegram bot — step 8.
 *
 * Two jobs: answer recommendation queries, and be the identity anchor that lets
 * web and bot settings converge on one `user_preferences` row.
 *
 * IDENTITY DESIGN. The cheapest scheme that stays on the free tier is a
 * bot-issued magic link: the user sends /link, the bot returns a URL carrying a
 * signed single-use token, and opening it sets a cookie bound to the same
 * user_id. No auth provider, no email, no password, no extra table beyond
 * `link_tokens`. Anonymous web visitors get defaults with no persistence.
 */

import { recommend, type RecommendRequest } from './recommend';
import { classify } from './classify';

const API = 'https://api.telegram.org/bot';

export interface TelegramUpdate {
  message?: {
    message_id: number;
    chat: { id: number };
    from?: { id: number; first_name?: string };
    text?: string;
  };
}

/**
 * Verify the request actually came from Telegram.
 *
 * Telegram echoes a secret configured at setWebhook time in this header. The
 * webhook URL is otherwise a public endpoint that would accept forged updates
 * from anyone who guessed it.
 */
export function verifyWebhook(req: Request, secret: string | undefined): boolean {
  if (!secret || secret.length < 16) return false;
  const got = req.headers.get('X-Telegram-Bot-Api-Secret-Token');
  if (!got) return false;

  // Constant-time comparison, same reasoning as the admin secret.
  const a = new TextEncoder().encode(got);
  const b = new TextEncoder().encode(secret);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export async function sendMessage(
  token: string,
  chatId: number | string,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await fetchImpl(`${API}${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** Stable user id derived from the Telegram chat. */
export function userIdForChat(chatId: number | string): string {
  return `tg:${chatId}`;
}

/**
 * Mint a single-use, time-limited link token.
 *
 * Randomness comes from crypto.getRandomValues rather than Math.random: this
 * token is a bearer credential for the account's settings, and a predictable
 * one would let anyone who guessed it bind their browser to another user's
 * preferences.
 */
export async function mintLinkToken(
  db: D1Database,
  userId: string,
  ttlMinutes = 15,
): Promise<string> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

  const expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();

  await db
    .prepare(
      `INSERT INTO link_tokens (token, user_id, expires_at, consumed) VALUES (?1, ?2, ?3, 0)`,
    )
    .bind(token, userId, expiresAt)
    .run();

  return token;
}

/**
 * Redeem a link token, returning the user id it was minted for.
 *
 * Single-use and expiry are enforced in ONE conditional UPDATE rather than a
 * read-then-write, so two simultaneous redemptions cannot both succeed.
 */
export async function redeemLinkToken(db: D1Database, token: string): Promise<string | null> {
  if (!/^[0-9a-f]{64}$/.test(token)) return null;

  const now = new Date().toISOString();
  const res = await db
    .prepare(
      `UPDATE link_tokens SET consumed = 1
        WHERE token = ?1 AND consumed = 0 AND expires_at > ?2`,
    )
    .bind(token, now)
    .run();

  if ((res.meta?.changes ?? 0) === 0) return null;

  const row = await db
    .prepare(`SELECT user_id FROM link_tokens WHERE token = ?1`)
    .bind(token)
    .first<{ user_id: string }>();

  return row?.user_id ?? null;
}

export async function ensureUser(db: D1Database, userId: string, chatId?: number | string) {
  await db
    .prepare(
      `INSERT INTO user_preferences (user_id, telegram_chat_id) VALUES (?1, ?2)
       ON CONFLICT(user_id) DO UPDATE SET telegram_chat_id = COALESCE(excluded.telegram_chat_id, telegram_chat_id)`,
    )
    .bind(userId, chatId != null ? String(chatId) : null)
    .run();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));

export function renderRecommendation(res: Awaited<ReturnType<typeof recommend>>): string {
  if (res.results.length === 0) {
    return `No route found.\n${esc(res.notice ?? 'Try a different task or switch off free-only.')}`;
  }

  const lines: string[] = [];
  lines.push(`<b>${esc(res.medium.assignedLabel.toUpperCase())}</b> — ${esc(res.medium.reason)}`);
  lines.push('');

  res.results.slice(0, 3).forEach((o, i) => {
    const provenance = o.score_scope === 'harness_measured' ? 'measured' : 'model-only';
    const quota =
      o.quota_value != null
        ? `${o.quota_value} ${String(o.quota_unit ?? '').replace(/_/g, ' ')}${o.quota_shared ? ' shared' : ''}`
        : 'quota unknown';
    lines.push(`<b>${i + 1}. ${esc(o.model_id)}</b>`);
    lines.push(`   via ${esc(o.harness_id)} · ${o.score.toFixed(1)} · ${provenance}`);
    lines.push(`   ${esc(quota)}`);
  });

  if (res.upgradeHint) {
    lines.push('');
    lines.push(`<i>${esc(res.upgradeHint)}</i>`);
  }
  if (res.citation) {
    lines.push('');
    lines.push(`<i>${esc(res.citation)}</i>`);
  }
  return lines.join('\n');
}

const HELP = [
  '<b>ModelMap</b> — which model, in which tool.',
  '',
  'Send any task description and I will route it.',
  '',
  '<b>/link</b> — connect this chat to the web board',
  '<b>/settings</b> — show current preferences',
  '<b>/set</b> key value — change one (free_only, min_context, alerts_enabled)',
  '<b>/alerts</b> on|off — toggle rank-change alerts',
  '<b>/help</b> — this message',
].join('\n');

// ---------------------------------------------------------------------------
// Command handling
// ---------------------------------------------------------------------------

export interface BotEnv {
  DB: D1Database;
  CACHE: KVNamespace;
  TELEGRAM_BOT_TOKEN?: string;
  PUBLIC_URL?: string;
}

/** Settings a user may change from either surface. Whitelisted deliberately. */
const SETTABLE: Record<string, { column: string; parse: (v: string) => number | null }> = {
  free_only: { column: 'free_only', parse: (v) => (/^(1|on|true|yes)$/i.test(v) ? 1 : 0) },
  alerts_enabled: { column: 'alerts_enabled', parse: (v) => (/^(1|on|true|yes)$/i.test(v) ? 1 : 0) },
  min_context: {
    column: 'min_context',
    parse: (v) => {
      const n = Number(v.replace(/[k,]/gi, (m) => (m.toLowerCase() === 'k' ? '000' : '')));
      return Number.isFinite(n) && n >= 0 ? n : null;
    },
  },
  alert_threshold_pct: {
    column: 'alert_threshold_pct',
    parse: (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null),
  },
};

export async function handleUpdate(update: TelegramUpdate, env: BotEnv): Promise<void> {
  const msg = update.message;
  if (!msg?.text || !env.TELEGRAM_BOT_TOKEN) return;

  const chatId = msg.chat.id;
  const userId = userIdForChat(chatId);
  const text = msg.text.trim();
  const reply = (t: string) => sendMessage(env.TELEGRAM_BOT_TOKEN!, chatId, t);

  await ensureUser(env.DB, userId, chatId);

  if (text === '/start' || text === '/help') return reply(HELP);

  if (text === '/link') {
    const token = await mintLinkToken(env.DB, userId);
    const base = env.PUBLIC_URL ?? '';
    return reply(
      `Open this within 15 minutes to connect your browser:\n${base}/link?t=${token}\n\n` +
        `Single use. Settings changed in either place will show up in both.`,
    );
  }

  if (text === '/settings') {
    const p = await env.DB.prepare(
      `SELECT free_only, min_context, alerts_enabled, alert_threshold_pct,
              openrouter_paid_credits
         FROM user_preferences WHERE user_id = ?1`,
    )
      .bind(userId)
      .first<Record<string, number>>();
    if (!p) return reply('No settings yet. Send a task first.');
    return reply(
      [
        '<b>Settings</b>',
        `free_only: ${p.free_only ? 'on' : 'off'}`,
        `min_context: ${p.min_context}`,
        `alerts_enabled: ${p.alerts_enabled ? 'on' : 'off'}`,
        `alert_threshold_pct: ${p.alert_threshold_pct}`,
        `openrouter paid credits: ${p.openrouter_paid_credits ? 'yes' : 'no'}`,
        '',
        'Change with: /set free_only off',
      ].join('\n'),
    );
  }

  if (text.startsWith('/alerts')) {
    const on = /on|1|true|yes/i.test(text.slice(7));
    await env.DB.prepare(`UPDATE user_preferences SET alerts_enabled = ?2 WHERE user_id = ?1`)
      .bind(userId, on ? 1 : 0)
      .run();
    return reply(`Alerts ${on ? 'on' : 'off'}.`);
  }

  if (text.startsWith('/set ')) {
    const [, key, ...rest] = text.split(/\s+/);
    const spec = SETTABLE[key];
    if (!spec) return reply(`Unknown setting. Try: ${Object.keys(SETTABLE).join(', ')}`);
    const value = spec.parse(rest.join(' '));
    if (value === null) return reply(`Could not read a value for ${esc(key)}.`);
    // Column name comes from the whitelist above, never from user input.
    await env.DB.prepare(
      `UPDATE user_preferences SET ${spec.column} = ?2 WHERE user_id = ?1`,
    )
      .bind(userId, value)
      .run();
    return reply(`${esc(key)} = ${value}`);
  }

  if (text.startsWith('/')) return reply(HELP);

  // Anything else is a task.
  const prefs = await env.DB.prepare(
    `SELECT free_only, min_context FROM user_preferences WHERE user_id = ?1`,
  )
    .bind(userId)
    .first<{ free_only: number; min_context: number }>();

const req: RecommendRequest = {
    task: text,
    tier: prefs?.free_only === 0 ? 'all' : 'free',
    size: inferSize(text),
    quality: 'benchmark',
    needsExecution: /\b(shell|terminal|bash|deploy|run |install|command)\b/i.test(text),
    needsFileWrites: /\b(file|refactor|edit|write to|codebase|repo)\b/i.test(text),
    limit: 3,
  };

  const res = await recommend(env.CACHE, req);
  return reply(renderRecommendation(res));
}

/**
 * Guess payload size from the task text.
 *
 * The web UI has a size control; the bot does not, so this infers one. Defaults
 * to 'medium' — the conservative middle, since guessing 'small' would overstate
 * quota sufficiency and guessing 'large' would filter out usable models.
 */
export function inferSize(text: string): RecommendRequest['size'] {
  if (/\b(whole|entire|full)\s+(project|repo|codebase)\b/i.test(text)) return 'large';
  if (/\b(agent|autonomous|long[- ]running|overnight|pipeline)\b/i.test(text)) return 'agent';
  if (/\b(quick|simple|one|single|short)\b/i.test(text)) return 'small';
  return 'medium';
}

export { classify };
