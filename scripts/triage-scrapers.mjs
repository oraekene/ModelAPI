/**
 * Triage scrapers from a scraper-index.json (from /admin/scrapers or
 * scripts/export-scraper-index.mjs).
 * Usage: node scripts/triage-scrapers.mjs [scraper-index.json] [outfile.md]
 *
 * Buckets:
 *   blocked     — in the blocklist right now (dead endpoints, missing keys).
 *   failing     — last run errored/timeout (below the block threshold yet).
 *   empty       — last status ok but never produced a single model across all
 *                 runs (models_found = 0) -> stub candidates for deletion.
 *   healthy     — produced models and is not blocked.
 *   never_run   — no health row yet.
 */
import fs from 'node:fs';

const input = process.argv[2] ?? 'scraper-index.json';
const output = process.argv[3] ?? 'triage-scrapers.md';

const index = JSON.parse(fs.readFileSync(input, 'utf8'));
const scrapers = index.scrapers ?? [];
if (scrapers.length === 0) {
  console.error('No scrapers in the index. Did the export succeed?');
  process.exit(1);
}

const bucketOf = (s) => {
  if (s.blocked) return 'blocked';
  if (s.last_status === 'never_run') return 'never_run';
  if (s.last_status === 'error' || s.last_status === 'timeout') return 'failing';
  return s.models_found > 0 ? 'healthy' : 'empty';
};

const buckets = { blocked: [], failing: [], empty: [], healthy: [], never_run: [] };
for (const s of scrapers) buckets[bucketOf(s)].push(s);
for (const list of Object.values(buckets)) list.sort((a, b) => a.id.localeCompare(b.id));

const esc = (v) => String(v ?? '').replace(/\|/g, '/').replace(/\n/g, ' ').slice(0, 90);
const row = (s) =>
  `| ${s.id} | ${s.category} | ${s.last_status} | ${s.models_found} | ${s.consecutive_failures} | ${esc(s.last_error)} | ${esc(s.blocked_until)} |`;

const lines = [
  `# Scraper triage (${index.generated_at ?? 'unknown time'})`,
  '',
  `Total ${scrapers.length}: ${buckets.healthy.length} healthy, ${buckets.empty.length} empty, ` +
    `${buckets.failing.length} failing, ${buckets.blocked.length} blocked, ${buckets.never_run.length} never run.`,
  '',
];

const section = (title, note, list) => {
  if (list.length === 0) return;
  lines.push(`## ${title} (${list.length})`, '', note, '',
    '| scraper | category | status | models_found | fails | last_error | blocked_until |',
    '| :--- | :--- | :--- | ---: | ---: | :--- | :--- |',
    ...list.map(row), '');
};

section('Blocked', 'Skipped by the fan-out; expires for one re-probe when blocked_until passes.', buckets.blocked);
section('Failing', 'Below the block threshold; watch until 3 consecutive failures.', buckets.failing);
section('Empty', 'Reachable but never yielded a model — stub candidates for deletion.', buckets.empty);
section('Never run', 'No health row yet; will appear after the first cron tick.', buckets.never_run);
section('Healthy', 'Producing models.', buckets.healthy);

fs.writeFileSync(output, lines.join('\n'));
console.log(`wrote ${output}`);
console.log(
  `healthy ${buckets.healthy.length}, empty ${buckets.empty.length}, failing ${buckets.failing.length}, ` +
    `blocked ${buckets.blocked.length}, never_run ${buckets.never_run.length}`,
);
