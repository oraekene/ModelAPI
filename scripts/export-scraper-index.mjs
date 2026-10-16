/**
 * Export scraper-index.json from a deployed ModelMap worker.
 * Usage: MODELMAP_URL=https://modelmap.example.workers.dev ADMIN_SECRET=... node scripts/export-scraper-index.mjs [outfile]
 */
import fs from 'node:fs';

const url = process.env.MODELMAP_URL;
const secret = process.env.ADMIN_SECRET;
if (!url || !secret) {
  console.error('Set MODELMAP_URL and ADMIN_SECRET first.');
  process.exit(1);
}

const res = await fetch(`${url.replace(/\/$/, '')}/admin/scrapers`, {
  headers: { 'X-ModelMap-Admin': secret },
});
if (!res.ok) {
  console.error(`GET /admin/scrapers -> HTTP ${res.status}`);
  process.exit(1);
}

const out = process.argv[2] ?? 'scraper-index.json';
const body = await res.text();
JSON.parse(body); // fail loudly on a non-JSON body before writing
fs.writeFileSync(out, body);
const index = JSON.parse(body);
console.log(`wrote ${out}: ${index.count} scrapers, ${index.blocked_count} blocked`);
