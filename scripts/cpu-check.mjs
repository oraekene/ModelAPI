/**
 * Measure the pure-CPU cost of one ingest slice.
 *   node scripts/cpu-check.mjs [sliceSize] [iterations]
 *
 * Timing ONLY parse + normalisation — the part that happens inside the queue
 * consumer's 10 ms budget. Network and D1 round-trips are excluded on purpose:
 * worker wall time in those is not charged to CPU.
 *
 * Usage: node scripts/cpu-check.mjs 25 300
 */

import { performance } from 'node:perf_hooks';

const sliceSize = Number(process.argv[2] ?? 25);
const iterations = Number(process.argv[3] ?? 300);

// A realistic model-slice payload: ~140 bytes per model, JSON-stringified,
// shaped like the live /api/v1/models response.
function makePayload(n) {
  const data = [];
  for (let i = 0; i < n; i++) {
    data.push({
      id: `vendor/model-${i}:free`,
      name: `Vendor Model ${i}`,
      context_length: 128_000 + i * 1000,
      pricing: { prompt: 0, completion: 0 },
      modalities: { input: ['text', 'image'], output: ['text'] },
      supported_parameters: ['tools', 'logit_bias'],
    });
  }
  return { data };
}

function normaliseModel(raw) {
  return {
    id: raw.id,
    context_length: raw.context_length ?? null,
    isFree: /:free/i.test(raw.id),
    supportsVision: Array.isArray(raw.modalities?.input) &&
      raw.modalities.input.some((t) => typeof t === 'string' && /image|vision/i.test(t)),
    supportsTools: Array.isArray(raw.supported_parameters) &&
      raw.supported_parameters.some((p) => /tools?|function|call/i.test(String(p))),
    pricePrompt: Number(raw.pricing?.prompt ?? 0),
    priceCompletion: Number(raw.pricing?.completion ?? 0),
  };
}

const payload = JSON.stringify(makePayload(sliceSize));
const bytes = Buffer.byteLength(payload);

// Warm-up (JIT + lazy helpers).
for (let i = 0; i < 50; i++) JSON.parse(payload).data.slice(0, 5).map(normaliseModel);

const samples = [];
for (let i = 0; i < iterations; i++) {
  const t0 = performance.now();
  const parsed = JSON.parse(payload);
  const slice = parsed.data.slice(0, sliceSize);
  for (const m of slice) normaliseModel(m);
  samples.push(performance.now() - t0);
}

samples.sort((a, b) => a - b);
const median = samples[Math.floor(samples.length / 2)];
const p95 = samples[Math.floor(samples.length * 0.95)];
const max = samples[samples.length - 1];

const rows = [
  ['slice size', sliceSize],
  ['payload', `${(bytes / 1024).toFixed(1)} KB`],
  ['iterations', iterations],
  ['median', `${median.toFixed(3)} ms`],
  ['p95', `${p95.toFixed(3)} ms`],
  ['max', `${max.toFixed(3)} ms`],
];

console.log('\nCPU profile — parse + normalise only, Node (not workerd):\n');
for (const [k, v] of rows) console.log(`  ${k.padEnd(10)} ${v}`);

console.log(`
Headroom vs the 10ms Workers Free limit:
  median ${(10 / median).toFixed(0)}x under, p95 ${(10 / p95).toFixed(0)}x under.
  max   ${max < 10 ? `${(10 / max).toFixed(0)}x under` : 'AT OR OVER — shrink SLICE_SIZE'}

Node is a signal, not a prediction: workerd's GC and JIT differ. The real check
is the CPU-time column in the Workers dashboard after the first live run.
`);

if (max >= 10) process.exit(1);