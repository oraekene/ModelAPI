/**
 * Block-detection guard — normal docs pages often contain "Rate Limit",
 * "please wait" or "enable JavaScript"; those must not count as bot blocks.
 *
 *   node scripts/test-crawl-block.mjs
 */

import { isBlocked } from '../src/scrapers/crawl-utils.ts';

let passed = 0, failed = 0;
const check = (name, condition) => {
  if (condition) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}`); }
};

const response = (status) => new Response('', { status });

check('docs text with "Rate Limit" is not blocked', !isBlocked(response(200), '<a>Rate Limit &amp; Isolation</a>'));
check('docs text with "please wait" is not blocked', !isBlocked(response(200), '<p>Please wait while the page loads.</p>'));
check('docs text with "enable JavaScript" is not blocked', !isBlocked(response(200), '<noscript>Enable JavaScript</noscript>'));
check('Cloudflare challenge is blocked', isBlocked(response(200), '<title>Just a moment...</title>'));
check('403 response is blocked', isBlocked(response(403), ''));
check('429 response is blocked', isBlocked(response(429), ''));

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
