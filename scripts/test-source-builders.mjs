/**
 * Tests for the source-builders (models.dev slicer, freellm.sh extractor) and
 * the models.dev worker mapping.
 *
 * Run: node scripts/test-source-builders.mjs
 */
import assert from 'node:assert/strict';
import { chunkProviders, buildIndex, SLICE_MODEL_CAP } from './build-models-dev-slices.mjs';
import { extractFreellmEntries, joinFlightChunks, scanBalanced } from './build-freellm-snapshot.mjs';
import { extractFreellmNetRows } from './build-freellm-net-snapshot.mjs';
import { buildSnapshot } from './build-awesome-ai-api-snapshot.mjs';

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
// freellm.net extractor (real helpers from the build script)
// ---------------------------------------------------------------------------

console.log('freellm.net extractor:');

const netRow = (attrs = '') =>
  `<tr class="model-row clickable-row" data-href="/models/nvidia-nim/z-ai-glm-5-3" data-name="z-ai/glm-5.3" data-provider="NVIDIA NIM" data-provider-slug="nvidia-nim" data-modality="text,reasoning" data-free="1" data-nocard="1" data-verified="1" data-nophone="0" data-score="95" data-context="1048576" data-released="1787011200000" data-tier-type="permanent" ${attrs}><td>x</td></tr>`;

t('extracts attribute-encoded rows', () => {
  const rows = extractFreellmNetRows(netRow());
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'z-ai/glm-5.3');
  assert.equal(rows[0].providerSlug, 'nvidia-nim');
  assert.deepEqual(rows[0].modality, ['text', 'reasoning']);
  assert.equal(rows[0].free, true);
  assert.equal(rows[0].nocard, true);
  assert.equal(rows[0].nophone, false);
  assert.equal(rows[0].score, 95);
  assert.equal(rows[0].context, 1048576);
  assert.equal(rows[0].tierType, 'permanent');
});

t('skips rows without name or provider', () => {
  assert.equal(extractFreellmNetRows('<tr class="model-row" data-name="x"></tr>').length, 0);
  assert.equal(extractFreellmNetRows(netRow().replace(' data-provider="NVIDIA NIM"', '')).length, 0);
});

t('decodes entities in attribute values', () => {
  const rows = extractFreellmNetRows(netRow().replace('data-provider="NVIDIA NIM"', 'data-provider="A &amp; B"'));
  assert.equal(rows[0].provider, 'A & B');
});

t('returns empty on a page without the table', () => {
  assert.equal(extractFreellmNetRows('<html><body>nope</body></html>').length, 0);
});

// ---------------------------------------------------------------------------
// awesome-ai-api snapshot narrowing (real helpers from the build script)
// ---------------------------------------------------------------------------

console.log('awesome-ai-api snapshot:');

t('narrows gateways and drops slugless rows', () => {
  const out = buildSnapshot({
    gateways: [
      { slug: 'buzzai-cc', name: 'BUZZ', url: 'https://buzzai.cc', payment: ['card'], reachable: true, uptime: { uptime_pct: 96.7 }, verdict: 'likely_relay', extra: 'dropped' },
      { name: 'no slug here' },
    ],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].slug, 'buzzai-cc');
  assert.equal(out[0].reachable, true);
  assert.equal(out[0].verdict, 'likely_relay');
  assert.equal(out[0].extra, undefined, 'unknown fields are dropped');
});

t('reachable is strictly boolean, never a truthy string', () => {
  assert.equal(buildSnapshot([{ slug: 'x', reachable: 'true' }])[0].reachable, false);
});

// ---------------------------------------------------------------------------
// awesome-free-ai-coding mapper (mirror of src/scrapers/awesome-free-ai-coding.ts)
// ---------------------------------------------------------------------------

function afacMap(entries) {
  const out = [];
  for (const e of entries) {
    if (e.archived || typeof e.id !== 'string' || !e.id || typeof e.url !== 'string' || !e.url) continue;
    const apiIds = Array.isArray(e.api?.model_ids)
      ? e.api.model_ids.filter((m) => typeof m === 'string' && m.trim() !== '')
      : [];
    const families = (e.models ?? [])
      .map((m) => (typeof m.aa_model === 'string' && m.aa_model ? m.aa_model : m.family))
      .filter((m) => typeof m === 'string' && m.trim() !== '');
    const ids = [...new Set((apiIds.length > 0 ? apiIds : families).map((m) => m.trim()))];
    for (const id of ids) {
      const scoreKey = id.split('/').pop()?.replace(/:free$/, '') ?? id;
      out.push({ modelId: `${e.id}/${id}`, harnessId: 'awesome-free-ai-coding', isFree: 1, scoreKey, accessUrl: e.api?.base_url ?? e.url });
    }
  }
  return out;
}

console.log('awesome-free-ai-coding mapper:');

t('prefers exact api model ids over family names', () => {
  const rows = afacMap([{ id: 'openrouter-free', url: 'https://openrouter.ai', api: { model_ids: ['a/b:free'] }, models: [{ family: 'b' }] }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].modelId, 'openrouter-free/a/b:free');
  assert.equal(rows[0].scoreKey, 'b', ':free is stripped from the join key');
  assert.equal(rows[0].isFree, 1);
});

t('falls back to family/aa_model names when there is no api list', () => {
  const rows = afacMap([{ id: 'x', url: 'https://x', models: [{ family: 'f1' }, { family: 'f2', aa_model: 'f2-aa' }] }]);
  assert.deepEqual(rows.map((r) => r.modelId), ['x/f1', 'x/f2-aa']);
});

t('dedupes repeated ids', () => {
  const rows = afacMap([{ id: 'x', url: 'https://x', api: { model_ids: ['m', 'm', ' n '] } }]);
  assert.deepEqual(rows.map((r) => r.modelId), ['x/m', 'x/n']);
});

t('skips archived entries and entries without id or url', () => {
  const rows = afacMap([
    { id: 'a', url: 'https://a', archived: true, api: { model_ids: ['m'] } },
    { id: 'b', api: { model_ids: ['m'] } },
    { url: 'https://c', api: { model_ids: ['m'] } },
  ]);
  assert.equal(rows.length, 0);
});

// ---------------------------------------------------------------------------
console.log(`\n${passed} tests passed`);
