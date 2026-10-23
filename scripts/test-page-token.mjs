/**
 * Page-token tests — mirrors the signed bearer used by the static app.
 *
 *   node scripts/test-page-token.mjs
 */

import {
  mintPageToken,
  verifyPageToken,
  PAGE_TOKEN_TTL_SECONDS,
} from '../src/page-token.ts';

let passed = 0, failed = 0;
const check = (name, condition) => {
  if (condition) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}`); }
};

const secret = 'a'.repeat(64);
const now = 1_700_000_000_000;
const token = await mintPageToken('tg:123', secret, now);

check('mints a three-part token', typeof token === 'string' && token.split('.').length === 3);
check('round-trips the user id', (await verifyPageToken(token, secret, now)) === 'tg:123');
check('rejects a different secret', (await verifyPageToken(token, 'b'.repeat(64), now)) === null);
check('rejects an expired token', (await verifyPageToken(token, secret, now + PAGE_TOKEN_TTL_SECONDS * 1000)) === null);
check('rejects a tampered payload', (await verifyPageToken(token.replace(/^v1\.(.)/, (_, c) => `v1.${c === 'A' ? 'B' : 'A'}`), secret, now)) === null);
check('refuses a short signing secret', (await mintPageToken('tg:123', 'short', now)) === null);
check('refuses an invalid user id', (await mintPageToken('bad user', secret, now)) === null);
check('rejects a malformed token', (await verifyPageToken('not-a-token', secret, now)) === null);

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
