/**
 * Build data/freellm-net.json — a fresh snapshot of freellm.net's model table.
 *
 * freellm.net has no data API (probed P6: every /api/* path 404s); the 900 KB
 * /models/ page carries one <table id="modelsTable"> whose rows are fully
 * attribute-encoded (data-name, data-provider-slug, data-score, data-context,
 * data-nocard, data-verified, ...). That makes a build-time parse cheap and
 * exact, unlike the HTML cells.
 *
 * The worker does not consume this file; it is a committed artifact for the
 * app, refreshed twice weekly like the other sources:
 *   node scripts/build-freellm-net-snapshot.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SOURCE_URL = 'https://freellm.net/models/';
const OUT_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'data',
  'freellm-net.json',
);
const MIN_EXPECTED_ROWS = 100;

const ENTITIES = { '&amp;': '&', '&quot;': '"', '&#39;': "'", '&lt;': '<', '&gt;': '>', '&nbsp;': ' ' };
export function decodeEntities(s) {
  return s.replace(/&(?:amp|quot|#39|lt|gt|nbsp);/g, (m) => ENTITIES[m] ?? m);
}

/** Extract the attribute-encoded rows of freellm.net's model table. */
export function extractFreellmNetRows(html) {
  const rows = [];
  const rowRe = /<tr class="model-row[^"]*"[^>]*>/g;
  let m;
  while ((m = rowRe.exec(html)) !== null) {
    const tag = m[0];
    const attr = (name) => {
      const r = new RegExp(`data-${name}="([^"]*)"`).exec(tag);
      return r ? decodeEntities(r[1]) : null;
    };
    const num = (name) => {
      const v = attr(name);
      return v !== null && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : null;
    };
    const name = attr('name');
    const provider = attr('provider');
    if (!name || !provider) continue;
    rows.push({
      name,
      provider,
      providerSlug: attr('provider-slug'),
      modality: attr('modality') ? attr('modality').split(',').filter(Boolean) : [],
      free: attr('free') === '1',
      nocard: attr('nocard') === '1',
      nophone: attr('nophone') === '1',
      verified: attr('verified') === '1',
      description: attr('description'),
      bestfor: attr('bestfor'),
      tag: attr('tag'),
      score: num('score'),
      context: num('context'),
      released: num('released'),
      tierType: attr('tier-type'),
      href: attr('href'),
    });
  }
  return rows;
}

async function main() {
  const res = await fetch(SOURCE_URL, { headers: { 'User-Agent': 'ModelMapBot/1.0 (+https://github.com/oraekene/ModelAPI)' } });
  if (!res.ok) throw new Error(`freellm.net HTTP ${res.status}`);
  const rows = extractFreellmNetRows(await res.text());
  if (rows.length < MIN_EXPECTED_ROWS) {
    throw new Error(`freellm.net returned only ${rows.length} rows (expected >= ${MIN_EXPECTED_ROWS})`);
  }

  const before = fs.existsSync(OUT_FILE) ? JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')) : null;
  if (before && JSON.stringify(before.rows) === JSON.stringify(rows)) {
    console.log(`freellm.net: ${rows.length} rows, unchanged`);
    return;
  }
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(
    OUT_FILE,
    JSON.stringify({ generated: new Date().toISOString(), source: SOURCE_URL, count: rows.length, rows }, null, 1),
  );
  console.log(`freellm.net: ${rows.length} rows written (was ${before?.count ?? 0})`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
