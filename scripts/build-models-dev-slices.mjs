/**
 * Build data/models-dev/ — committed slices of models.dev/api.json.
 *
 * Why slices: api.json is ~5.6 MB and a Worker's CPU budget cannot JSON.parse it
 * in one queue invocation. Each slice is the same shape as api.json (a map of
 * provider -> { ...meta, models }) with a cap of ~SLICE_MODEL_CAP models, so a
 * slice parses in a couple of milliseconds. A provider larger than the cap is
 * split across slices (provider meta is repeated in each fragment).
 *
 * Runs in GitHub Actions twice weekly (.github/workflows/refresh-sources.yml),
 * and can be run locally:  node scripts/build-models-dev-slices.mjs
 *
 * Pure helpers are exported so tests can call them directly.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SOURCE_URL = 'https://models.dev/api.json';
export const SLICE_MODEL_CAP = 150;
const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'models-dev');

/** Split api.json into slice fragments, each with at most SLICE_MODEL_CAP models. */
export function chunkProviders(api, cap = SLICE_MODEL_CAP) {
  const providerIds = Object.keys(api).sort();
  const slices = [];
  let current = {};
  let currentModels = 0;

  const flush = () => {
    if (Object.keys(current).length > 0) {
      slices.push(current);
      current = {};
      currentModels = 0;
    }
  };

  for (const pid of providerIds) {
    const provider = api[pid];
    const models = provider?.models && typeof provider.models === 'object' ? provider.models : {};
    const modelIds = Object.keys(models).sort();
    if (modelIds.length === 0) {
      current[pid] = { ...provider, models: {} };
      continue;
    }
    for (const mid of modelIds) {
      if (!current[pid]) {
        const { models: _drop, ...meta } = provider;
        current[pid] = { ...meta, models: {} };
      }
      current[pid].models[mid] = models[mid];
      currentModels++;
      if (currentModels >= cap) flush();
    }
  }
  flush();
  return slices;
}

export function buildIndex(api, slices, generatedAt) {
  return {
    generated_at: generatedAt,
    source: SOURCE_URL,
    provider_count: Object.keys(api).length,
    model_count: Object.values(api).reduce((n, p) => n + Object.keys(p?.models ?? {}).length, 0),
    slices: slices.map((s, i) => ({
      file: `slice-${String(i).padStart(3, '0')}.json`,
      models: Object.values(s).reduce((n, p) => n + Object.keys(p.models ?? {}).length, 0),
      providers: Object.keys(s),
    })),
  };
}

/** Write only what changed; returns [written, removed] file counts. */
export function writeIfChanged(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  let written = 0;
  for (const [name, content] of Object.entries(files)) {
    const p = path.join(dir, name);
    if (fs.existsSync(p) && fs.readFileSync(p, 'utf8') === content) continue;
    fs.writeFileSync(p, content);
    written++;
  }
  let removed = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!(name in files)) {
      fs.unlinkSync(path.join(dir, name));
      removed++;
    }
  }
  return [written, removed];
}

async function main() {
  const res = await fetch(SOURCE_URL, { headers: { 'User-Agent': 'ModelMapBot/1.0 (+https://github.com/oraekene/ModelAPI)' } });
  if (!res.ok) throw new Error(`models.dev HTTP ${res.status}`);
  const api = await res.json();
  if (!api || typeof api !== 'object' || Object.keys(api).length < 100) {
    throw new Error(`models.dev payload looks wrong (${Object.keys(api ?? {}).length} providers)`);
  }

  const slices = chunkProviders(api);
  const index = buildIndex(api, slices, new Date().toISOString());
  const files = { 'index.json': JSON.stringify(index, null, 1) };
  slices.forEach((s, i) => {
    files[index.slices[i].file] = JSON.stringify(s);
  });

  const [written, removed] = writeIfChanged(OUT_DIR, files);
  const sizes = index.slices.map((s) => s.models);
  console.log(
    `models.dev: ${index.provider_count} providers, ${index.model_count} models -> ${slices.length} slices ` +
      `(${Math.min(...sizes)}-${Math.max(...sizes)} models each); ${written} files written, ${removed} removed`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
