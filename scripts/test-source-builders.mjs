/**
 * Tests for the source-builders (models.dev slicer, freellm.sh extractor) and
 * the models.dev worker mapping.
 *
 * Run: node scripts/test-source-builders.mjs
 */
import assert from 'node:assert/strict';
import { chunkProviders, buildIndex, SLICE_MODEL_CAP } from './build-models-dev-slices.mjs';
import { extractFreellmEntries, joinFlightChunks, scanBalanced } from './build-freellm-snapshot.mjs';

let passed = 0;
const t = (name, fn) => {
  fn();
  passed++;
  console.log(`  ok ${name}`);
};

// ---------------------------------------------------------------------------
// models.dev slicer
// ---------------------------------------------------------------------------

function fakeApi() {
  const mk = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`m${i}`, { name: `M${i}` }]));
  return {
    zeta: { name: 'Zeta', models: mk(2) },
    alpha: { name: 'Alpha', models: mk(3) },
    big: { name: 'Big', models: mk(7) },
    empty: { name: 'Empty', models: {} },
  };
}

console.log('models.dev slicer:');

t('chunks respect the cap and lose no models', () => {
  const api = fakeApi();
  const slices = chunkProviders(api, 4);
  const seen = [];
  for (const s of slices) {
    const n = Object.values(s).reduce((sum, p) => sum + Object.keys(p.models).length, 0);
    assert.ok(n <= 4, `slice has ${n} models (>4)`);
    for (const [pid, p] of Object.entries(s)) for (const mid of Object.keys(p.models)) seen.push(`${pid}/${mid}`);
  }
  assert.equal(seen.length, 12);
  assert.equal(new Set(seen).size, 12, 'no duplicates across slices');
});

t('a provider larger than the cap is split across slices', () => {
  const slices = chunkProviders(fakeApi(), 4);
  const bigFrags = slices.filter((s) => s.big);
  assert.ok(bigFrags.length >= 2, `big provider spans ${bigFrags.length} slices`);
  for (const frag of bigFrags) assert.equal(frag.big.name, 'Big', 'provider meta repeated in fragments');
});

t('provider order is deterministic (sorted)', () => {
  const a = chunkProviders(fakeApi(), 4).map((s) => Object.keys(s).join(','));
  const b = chunkProviders(fakeApi(), 4).map((s) => Object.keys(s).join(','));
  assert.deepEqual(a, b);
});

t('empty-model providers survive as their own fragment', () => {
  const slices = chunkProviders(fakeApi(), 4);
  assert.ok(slices.some((s) => s.empty && Object.keys(s.empty.models).length === 0));
});

t('index counts providers, models and per-slice models', () => {
  const api = fakeApi();
  const slices = chunkProviders(api, 4);
  const index = buildIndex(api, slices, '2026-10-16T00:00:00Z');
  assert.equal(index.provider_count, 4);
  assert.equal(index.model_count, 12);
  assert.equal(index.slices.length, slices.length);
  const total = index.slices.reduce((n, s) => n + s.models, 0);
  assert.equal(total, 12);
  assert.match(index.slices[0].file, /^slice-000\.json$/);
});

t('default cap is sane for the Worker CPU budget', () => {
  assert.ok(SLICE_MODEL_CAP >= 50 && SLICE_MODEL_CAP <= 300, `cap ${SLICE_MODEL_CAP} outside 50..300`);
});

// ---------------------------------------------------------------------------
// freellm.sh extractor
// ---------------------------------------------------------------------------

const entry = (slug, extra = {}) => ({
  id: slug,
  name: `${slug} free`,
  provider: slug,
  providerSlug: slug,
  type: ['text'],
  access: ['free-tier', 'no-card'],
  status: 'operational',
  freeLimit: '50 req/day with] a bracket in text',
  tags: ['website'],
  addedAt: '2026-09-14T00:00:00.000Z',
  ...extra,
});

function fakeHtml(entries) {
  // Chunks like the real page: two prefix chunks, then the payload chunk.
  // JSON.stringify already produces the escaped, quoted JS string literal the
  // page embeds, so the fixture interpolates it directly.
  const payload = JSON.stringify(`1e:["$","$L20",null,{"models":${JSON.stringify(entries)}}]`);
  return `<script>self.__next_f.push([1,${JSON.stringify('2a:prefix')}])</script>` +
    `<script>self.__next_f.push([1,"3f:shell"])</script>` +
    `<script>self.__next_f.push([1,${payload}])</script>`;
}

console.log('freellm.sh extractor:');

t('joins escaped flight chunks', () => {
  const joined = joinFlightChunks(fakeHtml([entry('a')]));
  assert.ok(joined.includes('1e:'), 'payload chunk present');
  assert.ok(joined.includes('2a:prefix'), 'prefix chunk present');
});

t('scanBalanced handles brackets inside strings', () => {
  const text = '[{"freeLimit":"50] req"}]';
  assert.equal(scanBalanced(text, 0), text);
});

t('extracts and normalises entries', () => {
  const entries = extractFreellmEntries(fakeHtml([entry('openrouter'), entry('groq', { gated: true, url: 'https://x' })]));
  assert.equal(entries.length, 2);
  assert.equal(entries[0].providerSlug, 'openrouter');
  assert.equal(entries[0].gated, false, 'gated defaults to false');
  assert.equal(entries[0].url, null, 'url defaults to null');
  assert.equal(entries[1].gated, true);
  assert.equal(entries[1].url, 'https://x');
});

t('throws when the payload is gone', () => {
  assert.throws(() => extractFreellmEntries('<html><body>no data</body></html>'), /payload not found/);
});

t('ignores malformed chunks but still finds the payload', () => {
  const good = fakeHtml([entry('a')]);
  const withBad = good.replace('<script>self.__next_f.push([1,"2a:prefix"])</script>', '<script>self.__next_f.push([1,"trunc"...])</script>');
  assert.equal(extractFreellmEntries(withBad).length, 1);
});

// ---------------------------------------------------------------------------
console.log(`\n${passed} tests passed`);
