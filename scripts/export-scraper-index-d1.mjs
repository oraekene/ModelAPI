/**
 * Export scraper-index.json (same shape as GET /admin/scrapers) without the
 * ADMIN_SECRET, by reading health + blocklist straight from remote D1 and the
 * scraper ids/categories from the source files.
 *
 * Requires a logged-in wrangler with access to the `modelmap` D1 database.
 * Usage: node scripts/export-scraper-index-d1.mjs [outfile]
 *
 * Use this when the secret is not at hand; use export-scraper-index.mjs when
 * the worker is reachable with credentials (it reads the live registry, which
 * also covers scrapers defined outside src/scrapers/*.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRAPERS_DIR = path.join(ROOT, 'src', 'scrapers');
const out = process.argv[2] ?? 'scraper-index.json';

function query(sql) {
  const raw = execSync(
    `npx wrangler d1 execute modelmap --remote --json --command "${sql}"`,
    { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return JSON.parse(raw.slice(raw.indexOf('[')))[0].results ?? [];
}

/** Parse `readonly id/category/displayName = '...'` from every scraper source. */
function registryFromSource() {
  const scrapers = new Map();
  for (const file of fs.readdirSync(SCRAPERS_DIR)) {
    if (!file.endsWith('.ts') || file === 'base.ts') continue;
    const src = fs.readFileSync(path.join(SCRAPERS_DIR, file), 'utf8');
    const id = src.match(/readonly id = ['"]([^'"]+)['"]/)?.[1];
    if (!id) continue;
    scrapers.set(id, {
      id,
      category: src.match(/readonly category = ['"]([^'"]+)['"]/)?.[1] ?? 'unknown',
      displayName: src.match(/readonly displayName = ['"]([^'"]*)['"]/)?.[1] ?? id,
    });
  }
  return scrapers;
}

const health = query('SELECT scraper_id, last_status, last_error, consecutive_failures, models_found FROM scraper_health');
const blocked = query('SELECT scraper_id, blocked_at, reason, failures, expires_at FROM scraper_blocklist');
const healthById = new Map(health.map((r) => [r.scraper_id, r]));
const blockedById = new Map(blocked.map((r) => [r.scraper_id, r]));

const registry = registryFromSource();
// Union: source-derived scrapers + any health row the parse missed.
for (const h of health) {
  if (h.scraper_id && !registry.has(h.scraper_id)) {
    registry.set(h.scraper_id, { id: h.scraper_id, category: 'unknown', displayName: h.scraper_id });
  }
}

const now = new Date();
const scrapers = [...registry.values()].map((s) => {
  const h = healthById.get(s.id);
  const b = blockedById.get(s.id);
  const blockedNow = !!b?.expires_at && new Date(b.expires_at) > now;
  return {
    id: s.id,
    category: s.category,
    displayName: s.displayName,
    last_status: h?.last_status ?? 'never_run',
    last_error: h?.last_error ?? null,
    consecutive_failures: h?.consecutive_failures ?? 0,
    models_found: h?.models_found ?? 0,
    blocked: blockedNow,
    blocked_until: blockedNow ? b.expires_at : null,
    block_reason: blockedNow ? b.reason : null,
  };
});

const index = {
  generated_at: now.toISOString(),
  count: scrapers.length,
  blocked_count: scrapers.filter((s) => s.blocked).length,
  scrapers,
};
fs.writeFileSync(out, JSON.stringify(index, null, 1));
console.log(`wrote ${out}: ${index.count} scrapers (${registry.size} from source), ${index.blocked_count} blocked`);
