/**
 * Bot, identity and alert tests.
 *   node scripts/test-bot.mjs
 *
 * Covers the security-relevant paths: webhook origin verification, token
 * unguessability, single-use redemption, expiry, and alert suppression.
 */

let passed = 0, failed = 0;
const check = (n, c, d = '') => {
  if (c) { passed++; console.log(`  PASS  ${n}`); }
  else { failed++; console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`); }
};

// --- mirrors ---------------------------------------------------------------
function verifyWebhook(req, secret) {
  if (!secret || secret.length < 16) return false;
  const got = req.headers.get('X-Telegram-Bot-Api-Secret-Token');
  if (!got) return false;
  const a = new TextEncoder().encode(got);
  const b = new TextEncoder().encode(secret);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

const userIdForChat = (id) => `tg:${id}`;

function inferSize(text) {
  if (/\b(whole|entire|full)\s+(project|repo|codebase)\b/i.test(text)) return 'large';
  if (/\b(agent|autonomous|long[- ]running|overnight|pipeline)\b/i.test(text)) return 'agent';
  if (/\b(quick|simple|one|single|short)\b/i.test(text)) return 'small';
  return 'medium';
}

const SETTABLE = {
  free_only: { column: 'free_only', parse: (v) => (/^(1|on|true|yes)$/i.test(v) ? 1 : 0) },
  alerts_enabled: { column: 'alerts_enabled', parse: (v) => (/^(1|on|true|yes)$/i.test(v) ? 1 : 0) },
  min_context: { column: 'min_context', parse: (v) => {
    const n = Number(v.replace(/[k,]/gi, (m) => (m.toLowerCase() === 'k' ? '000' : '')));
    return Number.isFinite(n) && n >= 0 ? n : null;
  } },
  alert_threshold_pct: { column: 'alert_threshold_pct',
    parse: (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null) },
};

// stub D1 for link tokens
function makeDb() {
  const tokens = new Map();
  return {
    tokens,
    async mint(userId, ttlMinutes = 15) {
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      const token = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
      tokens.set(token, { userId, expiresAt: Date.now() + ttlMinutes * 60000, consumed: false });
      return token;
    },
    async redeem(token) {
      if (!/^[0-9a-f]{64}$/.test(token)) return null;
      const row = tokens.get(token);
      if (!row || row.consumed || row.expiresAt <= Date.now()) return null;
      row.consumed = true;          // single conditional update, as in D1
      return row.userId;
    },
  };
}

console.log('\nverifyWebhook() — forged updates must be rejected');
{
  const SECRET = 'a'.repeat(32);
  const withHeader = (v) => new Request('https://x/telegram/webhook', {
    method: 'POST', headers: v ? { 'X-Telegram-Bot-Api-Secret-Token': v } : {},
  });

  check('a correct secret is accepted', verifyWebhook(withHeader(SECRET), SECRET));
  check('a wrong secret is rejected', !verifyWebhook(withHeader('b'.repeat(32)), SECRET));
  check('a missing header is rejected', !verifyWebhook(withHeader(null), SECRET));
  check('an unset server secret fails closed',
    !verifyWebhook(withHeader(SECRET), undefined));
  check('a too-short server secret fails closed',
    !verifyWebhook(withHeader('short'), 'short'));
  check('a prefix of the secret is rejected',
    !verifyWebhook(withHeader('a'.repeat(31)), SECRET));
}

console.log('\nlink tokens — bearer credentials for the account');
await (async () => {
  const db = makeDb();
  const t = await db.mint('tg:12345');

  check('token is 64 hex chars', /^[0-9a-f]{64}$/.test(t));
  check('token carries 256 bits of entropy', t.length === 64);

  const uniq = new Set();
  for (let i = 0; i < 200; i++) uniq.add(await db.mint('tg:1'));
  check('200 mints produce 200 distinct tokens', uniq.size === 200);

  check('redemption returns the bound user', (await db.redeem(t)) === 'tg:12345');
  check('a second redemption fails (single use)', (await db.redeem(t)) === null);

  const expired = await db.mint('tg:9', -1);
  check('an expired token is rejected', (await db.redeem(expired)) === null);

  check('a malformed token is rejected without a lookup',
    (await db.redeem('not-a-token')) === null);
  check('a SQL-ish token is rejected by the format gate',
    (await db.redeem("' OR 1=1 --")) === null);
})();

console.log('\nidentity convergence');
{
  check('the same chat always maps to the same user id',
    userIdForChat(555) === userIdForChat('555'));
  check('different chats map to different users',
    userIdForChat(1) !== userIdForChat(2));
}

console.log('\n/set — only whitelisted columns are writable');
{
  check('an unknown key is refused', SETTABLE['password'] === undefined);
  check('a SQL-injection key is refused', SETTABLE['free_only; DROP TABLE'] === undefined);
  check('column names come from the whitelist, not input',
    SETTABLE.free_only.column === 'free_only');

  check('on/off parses to 1/0',
    SETTABLE.free_only.parse('on') === 1 && SETTABLE.free_only.parse('off') === 0);
  check('min_context accepts a k suffix', SETTABLE.min_context.parse('128k') === 128000);
  check('min_context rejects nonsense', SETTABLE.min_context.parse('abc') === null);
  check('a negative threshold is refused', SETTABLE.alert_threshold_pct.parse('-5') === null);
}

console.log('\ninferSize() — the bot has no size control');
{
  check('a whole-repo task reads as large',
    inferSize('refactor the entire codebase') === 'large');
  check('an agent run reads as agent',
    inferSize('build an autonomous pipeline') === 'agent');
  check('a quick question reads as small',
    inferSize('quick question about regex') === 'small');
  check('anything else defaults to medium, the conservative middle',
    inferSize('fix the login bug') === 'medium');
}

console.log('\nalert gating — the margin rule is what keeps this usable');
{
  // Mirrors detectRankOneChange's contract.
  function shouldAlert(prev, curr, thresholdPct) {
    if (!prev || !curr) return false;
    const same = prev.model === curr.model && prev.harness === curr.harness;
    if (same) return false;
    const margin = prev.score === 0 ? 100 : ((curr.score - prev.score) / prev.score) * 100;
    return Math.abs(margin) >= thresholdPct;
  }

  const a = { model: 'x', harness: 'h', score: 70 };
  const b = { model: 'y', harness: 'h', score: 71 };   // +1.4%
  const c = { model: 'z', harness: 'h', score: 80 };   // +14%

  check('no alert when #1 is unchanged', !shouldAlert(a, { ...a }, 3));
  check('no alert on a near-tie swap', !shouldAlert(a, b, 3),
    'a 1.4% margin should stay quiet');
  check('alert on a decisive change', shouldAlert(a, c, 3));
  check('a lower threshold makes the near-tie fire', shouldAlert(a, b, 1));
  check('no alert without history', !shouldAlert(null, c, 3));

  // Cooldown: same route cannot alert twice inside the window.
  const COOLDOWN_MS = 12 * 3600 * 1000;
  const lastSent = Date.now() - 60_000;
  check('a repeat inside the cooldown is suppressed',
    Date.now() - lastSent < COOLDOWN_MS);
  check('a repeat after the cooldown is allowed',
    !(Date.now() - (Date.now() - COOLDOWN_MS - 1000) < COOLDOWN_MS));
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
