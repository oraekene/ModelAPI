/**
 * Build data/freellm-sh.json — a fresh snapshot of freellm.sh's directory.
 *
 * freellm.sh is a Next.js SPA: the HTML has no table, the data rides in the
 * React flight stream as self.__next_f.push([1,"<escaped chunk>"]) calls. This
 * extracts the provider entries from those chunks into the same flat schema as
 * the original P1 extraction (SOURCES-freellm.sh.json in bestmodelpicker).
 *
 * The worker does not consume this file directly; it is a committed, always-
 * fresh artifact for the app and for diffs. Runs twice weekly from
 * .github/workflows/refresh-sources.yml:  node scripts/build-freellm-snapshot.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SOURCE_URL = 'https://freellm.sh/';
const OUT_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'freellm-sh.json');
const MIN_EXPECTED_ENTRIES = 100;

/** Concatenate the escaped flight chunks embedded in the page's HTML. */
export function joinFlightChunks(html) {
  const chunks = [];
  const re = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      chunks.push(JSON.parse(m[1]));
    } catch {
      // A malformed chunk is a page-layout change signal, not data we can use.
    }
  }
  return chunks.join('');
}

/** Return the substring of `text` from the bracket at `start` to its match. */
export function scanBalanced(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (escaped) {
      escaped = false;
    } else if (inString) {
      if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
    } else if (c === '[') {
      depth++;
    } else if (c === ']') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced brackets in flight payload');
}

/** Extract provider entries from freellm.sh HTML. Throws if the payload is gone. */
export function extractFreellmEntries(html) {
  const joined = joinFlightChunks(html);
  const marker = '"models":[';
  let at = joined.indexOf(marker);
  while (at !== -1) {
    const arrStart = at + marker.length - 1;
    try {
      const arr = JSON.parse(scanBalanced(joined, arrStart));
      if (Array.isArray(arr) && arr.length > 0 && typeof arr[0]?.providerSlug === 'string') {
        return arr.map((e) => ({
          id: e.id,
          name: e.name,
          provider: e.provider,
          providerSlug: e.providerSlug,
          type: e.type ?? [],
          access: e.access ?? [],
          status: e.status ?? null,
          freeLimit: e.freeLimit ?? null,
          tags: e.tags ?? [],
          addedAt: e.addedAt ?? null,
          gated: e.gated ?? false,
          url: e.url ?? null,
        }));
      }
    } catch {
      // Not the array we want; keep scanning for a later "models":[ marker.
    }
    at = joined.indexOf(marker, at + 1);
  }
  throw new Error('freellm.sh models payload not found — page layout changed');
}

async function main() {
  const res = await fetch(SOURCE_URL, { headers: { 'User-Agent': 'ModelMapBot/1.0 (+https://github.com/oraekene/ModelAPI)' } });
  if (!res.ok) throw new Error(`freellm.sh HTTP ${res.status}`);
  const html = await res.text();
  const entries = extractFreellmEntries(html);
  if (entries.length < MIN_EXPECTED_ENTRIES) {
    throw new Error(`freellm.sh returned only ${entries.length} entries (expected >= ${MIN_EXPECTED_ENTRIES})`);
  }

  const json = JSON.stringify(entries, null, 1);
  const before = fs.existsSync(OUT_FILE) ? fs.readFileSync(OUT_FILE, 'utf8') : null;
  if (before === json) {
    console.log(`freellm.sh: ${entries.length} entries, unchanged`);
    return;
  }
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, json);
  console.log(`freellm.sh: ${entries.length} entries written (was ${before ? JSON.parse(before).length : 0})`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
