/**
 * Build data/awesome-ai-api.json — a fresh snapshot of Claws-ZH/awesome-ai-api's
 * gateway probe results.
 *
 * That repo probes every listed gateway's real OpenAI-compatible /v1/models
 * endpoint daily and publishes data/gateways.json with uptime, verdict and
 * probe evidence. Almost no gateway has real model samples (real_models_count
 * is 0 for ~97% of them), so this is provider-level metadata, not offerings —
 * the worker does not consume it. Committed artifact for the app and diffs,
 * same reasoning as data/freellm-sh.json:
 *   node scripts/build-awesome-ai-api-snapshot.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SOURCE_URL =
  'https://raw.githubusercontent.com/Claws-ZH/awesome-ai-api/master/data/gateways.json';
const OUT_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'data',
  'awesome-ai-api.json',
);
const MIN_EXPECTED_GATEWAYS = 100;

/** Narrow a raw gateway record to the fields worth keeping in the snapshot. */
export function narrowGateway(g) {
  return {
    slug: g.slug ?? null,
    name: g.name ?? null,
    url: g.url ?? null,
    region: g.region ?? null,
    payment: g.payment ?? [],
    engine: g.engine ?? null,
    reachable: g.reachable === true,
    http_status: g.http_status ?? null,
    has_api: g.has_api === true,
    probe: g.probe ?? null,
    uptime: g.uptime ?? null,
    upstream: g.upstream ?? null,
    note: g.note ?? null,
    score: g.score ?? null,
    verdict: g.verdict ?? null,
    last_verified: g.last_verified ?? null,
  };
}

export function buildSnapshot(raw) {
  const list = Array.isArray(raw) ? raw : (raw?.gateways ?? []);
  return list.filter((g) => typeof g?.slug === 'string' && g.slug).map(narrowGateway);
}

async function main() {
  const res = await fetch(SOURCE_URL, { headers: { 'User-Agent': 'ModelMapBot/1.0 (+https://github.com/oraekene/ModelAPI)' } });
  if (!res.ok) throw new Error(`awesome-ai-api gateways HTTP ${res.status}`);
  const gateways = buildSnapshot(await res.json());
  if (gateways.length < MIN_EXPECTED_GATEWAYS) {
    throw new Error(`awesome-ai-api returned only ${gateways.length} gateways (expected >= ${MIN_EXPECTED_GATEWAYS})`);
  }

  const before = fs.existsSync(OUT_FILE) ? JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')) : null;
  if (before && JSON.stringify(before.gateways) === JSON.stringify(gateways)) {
    console.log(`awesome-ai-api: ${gateways.length} gateways, unchanged`);
    return;
  }
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(
    OUT_FILE,
    JSON.stringify({ generated: new Date().toISOString(), source: 'https://github.com/Claws-ZH/awesome-ai-api', count: gateways.length, gateways }, null, 1),
  );
  console.log(`awesome-ai-api: ${gateways.length} gateways written (was ${before?.count ?? 0})`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
