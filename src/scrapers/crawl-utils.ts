/**
 * Crawl Utilities — Borrowed techniques from Scrapling, Camoufox, QMD
 *
 * Patterns adapted for Cloudflare Workers V8 runtime:
 * - Browser-realistic header profiles (Camoufox consistency principle)
 * - AutoThrottle with latency-based delay adjustment (Scrapling)
 * - Retry-After parsing and block detection (Scrapling)
 * - Content hashing for dedup (QMD)
 * - Resilient parsing with fallback chains (Scrapling)
 */

// ---------------------------------------------------------------------------
// 1. Browser-Realistic Header Profiles (Camoufox: internal consistency)
// ---------------------------------------------------------------------------

interface HeaderProfile {
  userAgent: string;
  headers: Record<string, string>;
}

// Weighted by real market share (Chrome 65%, Safari 18%, Firefox 3%, Edge 5%)
const HEADER_PROFILES: HeaderProfile[] = [
  // Chrome on Windows (most common)
  {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    headers: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
    },
  },
  // Chrome on macOS
  {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    headers: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"macOS"',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
    },
  },
  // Firefox on Windows
  {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
    headers: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Accept-Encoding': 'gzip, deflate, br',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
    },
  },
  // Safari on macOS
  {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15',
    headers: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
    },
  },
  // Edge on Windows
  {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
    headers: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Sec-Ch-Ua': '"Chromium";v="124", "Microsoft Edge";v="124", "Not-A.Brand";v="99"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
    },
  },
];

/**
 * Get a random browser-realistic header profile.
 * Weighted: Chrome 50%, Firefox 20%, Safari 15%, Edge 15%.
 */
export function getHeaderProfile(): HeaderProfile {
  const rand = Math.random();
  if (rand < 0.50) return HEADER_PROFILES[0]; // Chrome Windows
  if (rand < 0.70) return HEADER_PROFILES[1]; // Chrome macOS
  if (rand < 0.90) return HEADER_PROFILES[2]; // Firefox
  if (rand < 0.95) return HEADER_PROFILES[3]; // Safari
  return HEADER_PROFILES[4]; // Edge
}

/**
 * Build request headers for a URL with optional referer simulation.
 * Camoufox principle: all signals must be internally consistent.
 */
export function buildHeaders(url: string, options?: {
  referer?: string;
  extraHeaders?: Record<string, string>;
}): HeadersInit {
  const profile = getHeaderProfile();
  const headers: Record<string, string> = {
    'User-Agent': profile.userAgent,
    ...profile.headers,
  };

  // Simulate organic traffic: search engine → page
  if (options?.referer) {
    headers['Referer'] = options.referer;
  } else if (Math.random() < 0.7) {
    headers['Referer'] = 'https://www.google.com/';
  }

  // Geo-aware Accept-Language (default: US English)
  if (options?.extraHeaders?.['Accept-Language']) {
    headers['Accept-Language'] = options.extraHeaders['Accept-Language'];
  }

  return { ...headers, ...options?.extraHeaders };
}

// ---------------------------------------------------------------------------
// 2. AutoThrottle (Scrapling: latency-based delay adjustment)
// ---------------------------------------------------------------------------

export class AutoThrottle {
  private delays = new Map<string, number>();

  constructor(
    private startDelay = 2,
    private maxDelay = 30,
    private targetConcurrency = 1,
  ) {}

  delayFor(domain: string, floor = 0): number {
    if (!this.delays.has(domain)) {
      this.delays.set(domain, Math.max(floor, this.startDelay));
    }
    return Math.min(this.delays.get(domain)!, this.maxDelay);
  }

  /**
   * Record a request result and return the new delay.
   * Scrapling formula: new_delay = (current + target) / 2
   * On block: double delay or honor Retry-After.
   */
  record(domain: string, latencyMs: number, ok: boolean, retryAfterMs?: number): number {
    const current = this.delayFor(domain);
    const target = (latencyMs / 1000) / this.targetConcurrency;
    let newDelay = Math.max((current + target) / 2, target);

    if (!ok) {
      const penalty = retryAfterMs
        ? retryAfterMs / 1000
        : current * 2;
      newDelay = Math.max(newDelay, penalty, current);
    }

    newDelay = Math.min(Math.max(newDelay, 0.5), this.maxDelay);
    this.delays.set(domain, newDelay);
    return newDelay;
  }

  /** Get delay with jitter to avoid machine-like regularity. */
  delayWithJitter(domain: string): number {
    const base = this.delayFor(domain);
    // Uniform jitter: ±20%
    const jitter = base * 0.2 * (Math.random() * 2 - 1);
    return Math.max(0.5, base + jitter);
  }
}

// ---------------------------------------------------------------------------
// 3. Retry & Block Detection (Scrapling patterns)
// ---------------------------------------------------------------------------

const BLOCK_INDICATORS = [
  /captcha/i,
  /access denied/i,
  /just a moment/i,
  /checking your browser/i,
  /cf-browser-verification/i,
  /verify you are human/i,
];

/**
 * Detect if a response indicates we're blocked.
 */
export function isBlocked(response: Response, body: string): boolean {
  if (response.status === 403 || response.status === 429) return true;
  if (response.status === 503) return true; // Cloudflare challenge
  return BLOCK_INDICATORS.some((p) => p.test(body));
}

/**
 * Parse Retry-After header (supports both seconds and HTTP-date).
 */
export function parseRetryAfter(header: string | null): number {
  if (!header) return 5;
  const seconds = Number(header);
  if (!isNaN(seconds)) return seconds;
  // HTTP-date format: "Wed, 21 Oct 2015 07:28:00 GMT"
  const date = new Date(header);
  return isNaN(date.getTime()) ? 5 : Math.max(1, (date.getTime() - Date.now()) / 1000);
}

// ---------------------------------------------------------------------------
// 4. Content Hashing for Dedup (QMD pattern)
// ---------------------------------------------------------------------------

/**
 * Simple string hash (djb2) for content dedup.
 * QMD uses 6-char docid hashes; we use 8 for fewer collisions.
 */
export function contentHash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36).padStart(8, '0');
}

/**
 * Normalize a URL for dedup comparison.
 * Strips tracking params, trailing slashes, normalizes scheme.
 */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    // Remove tracking params
    const trackingParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'gclid', 'fbclid'];
    for (const p of trackingParams) u.searchParams.delete(p);
    // Normalize
    u.protocol = 'https:';
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
    u.pathname = u.pathname.replace(/\/+$/, '') || '/';
    u.search = u.searchParams.toString() ? `?${u.searchParams.toString()}` : '';
    return u.toString();
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// 5. Resilient HTML Parsing (Scrapling fallback chains)
// ---------------------------------------------------------------------------

/**
 * Extract text content from HTML, ignoring script/style tags.
 */
export function extractText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract all text from a specific element by CSS selector.
 * Falls back to extracting from the whole document if selector not found.
 */
export function extractTextBySelector(html: string, selector: string): string {
  // Simple CSS selector → extract content
  // For more complex parsing, use linkedom in the caller
  const regex = new RegExp(`<[^>]*class=["'][^"']*(?:${selector})[^"']*["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`, 'gi');
  const matches: string[] = [];
  let match;
  while ((match = regex.exec(html)) !== null) {
    matches.push(extractText(match[1]));
  }
  return matches.join('\n');
}

/**
 * Extract JSON from script tags matching a key pattern.
 * Works with Next.js __NEXT_DATA__, inline JSON, etc.
 */
export function extractJsonFromScripts(html: string, keyPattern?: RegExp): unknown[] {
  const results: unknown[] = [];
  const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let scriptMatch;

  while ((scriptMatch = scriptRegex.exec(html)) !== null) {
    const content = scriptMatch[1].trim();
    if (!content) continue;

    // Check if key pattern matches
    if (keyPattern && !keyPattern.test(content)) continue;

    // Try to extract JSON objects
    // Method 1: Direct JSON parse (for __NEXT_DATA__ style)
    try {
      const obj = JSON.parse(content);
      if (typeof obj === 'object' && obj !== null) {
        results.push(obj);
        continue;
      }
    } catch { /* not direct JSON */ }

    // Method 2: Find JSON objects in assignment expressions
    const jsonRegex = /(?:=|:)\s*(\{[\s\S]*?\})\s*[;,}\]]/g;
    let jsonMatch;
    while ((jsonMatch = jsonRegex.exec(content)) !== null) {
      try {
        const obj = JSON.parse(jsonMatch[1]);
        if (typeof obj === 'object' && obj !== null) {
          results.push(obj);
        }
      } catch { /* not valid JSON */ }
    }
  }

  return results;
}

/**
 * Extract JSON-LD structured data from the page.
 */
export function extractJsonLd(html: string): unknown[] {
  const results: unknown[] = [];
  const regex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    try {
      results.push(JSON.parse(match[1]));
    } catch { /* skip malformed */ }
  }
  return results;
}

/**
 * Find JSON arrays in the page that contain model-like objects.
 * Heuristic: looks for arrays with objects having "id", "name", or "model" keys.
 */
export function findModelJsonArrays(html: string): Record<string, unknown>[][] {
  const results: Record<string, unknown>[][] = [];

  // Find all JSON arrays in the page
  const arrayRegex = /\[[\s\S]*?\]/g;
  let match;

  while ((match = arrayRegex.exec(html)) !== null) {
    try {
      const arr = JSON.parse(match[0]);
      if (!Array.isArray(arr) || arr.length === 0) continue;

      // Check if first element looks like a model object
      const first = arr[0];
      if (typeof first !== 'object' || first === null) continue;

      const keys = Object.keys(first).map((k) => k.toLowerCase());
      const hasModelKeys = keys.some((k) =>
        ['id', 'name', 'model', 'slug', 'model_id', 'modelid'].includes(k),
      );

      if (hasModelKeys) {
        results.push(arr);
      }
    } catch { /* not valid JSON array */ }
  }

  return results;
}

// ---------------------------------------------------------------------------
// 6. Price Parsing (enhanced from WebCrawlerScraper)
// ---------------------------------------------------------------------------

/**
 * Parse price strings like "$0.50/1M tokens", "€1.20 per million", "¥0.002/1K".
 * Returns price per token.
 */
export function parsePricePerToken(priceStr: string): number | null {
  if (!priceStr) return null;
  const s = priceStr
    .toLowerCase()
    .replace(/[,\s]/g, '')
    .replace(/million/g, 'm')
    .replace(/thousand/g, 'k')
    .replace(/tokens?/g, '')
    .replace(/[€$£]/g, '');
  // Require an explicit /1M, per-million, /1K unit; a bare "128k tokens" is not a price.
  const match = s.match(/([\d.]+)(?:\/|per)(\d*)([km])/);
  if (!match) return null;
  const price = parseFloat(match[1]);
  if (isNaN(price)) return null;
  const qty = match[2] ? parseFloat(match[2]) : 1;
  const per = match[3] === 'k' ? 1_000 : 1_000_000;
  if (!(qty > 0)) return null;
  return price / (qty * per);
}

// ---------------------------------------------------------------------------
// 7. Model Detection Heuristics
// ---------------------------------------------------------------------------

/**
 * Detect model capabilities from name/description text.
 */
export function detectCapabilities(text: string): {
  supportsVision: number;
  supportsTools: number;
  isFree: number;
} {
  const lower = text.toLowerCase();
  return {
    supportsVision: /\b(vision|image|visual|multimodal)\b/i.test(lower) ? 1 : 0,
    supportsTools: /\b(function|tool|tool_use|function_calling)\b/i.test(lower) ? 1 : 0,
    isFree: /\b(free|tier|community)\b/i.test(lower) ? 1 : 0,
  };
}

/**
 * Extract context window from text near a model reference.
 * Looks for patterns like "128K", "32768 tokens", "context: 8192".
 */
export function extractContextWindow(text: string, modelName: string): number | null {
  // Try to find context window near the model name
  const modelEscaped = modelName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const nearby = text.match(new RegExp(`${modelEscaped}[^<]{0,300}`, 'i'))?.[0] ?? text;

  // Patterns: 128K, 32768 tokens, context: 8192, 128k context
  const patterns = [
    /(\d+(?:\.\d+)?)\s*[kK]\s*(?:tokens?|context|window)?/,
    /context(?:\s*(?:window|size|length))?\s*[:=]\s*(\d[\d,]*)/i,
    /(\d[\d,]*)\s*tokens?\s*(?:context|window)?/i,
  ];

  for (const pattern of patterns) {
    const match = nearby.match(pattern);
    if (match) {
      let num = parseInt(match[1].replace(/,/g, ''), 10);
      if (match[0].toLowerCase().includes('k')) num *= 1024;
      if (num > 0 && num < 10_000_000) return num;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// 8. robots.txt Compliance (Scrapling pattern)
// ---------------------------------------------------------------------------

const robotsCache = new Map<string, { allowed: boolean; crawlDelay: number }>();

/**
 * Check if a URL is allowed by robots.txt.
 * Caches results per domain.
 */
export async function checkRobotsTxt(url: string): Promise<{ allowed: boolean; crawlDelay: number }> {
  try {
    const u = new URL(url);
    const domain = u.origin;

    if (robotsCache.has(domain)) {
      return robotsCache.get(domain)!;
    }

    // Fetch robots.txt
    const res = await fetch(`${domain}/robots.txt`, {
      headers: { 'User-Agent': 'ModelMapBot/1.0' },
    });

    if (!res.ok) {
      robotsCache.set(domain, { allowed: true, crawlDelay: 0 });
      return { allowed: true, crawlDelay: 0 };
    }

    const text = await res.text();
    const lines = text.split('\n');

    let allowed = true;
    let crawlDelay = 0;
    let inUserAgent = false;

    for (const line of lines) {
      const trimmed = line.trim().toLowerCase();
      if (trimmed.startsWith('user-agent:')) {
        const agent = trimmed.split(':')[1]?.trim();
        inUserAgent = agent === '*' || agent?.includes('modelmap');
      }
      if (inUserAgent) {
        if (trimmed.startsWith('disallow:')) {
          const path = trimmed.split(':')[1]?.trim();
          if (path && u.pathname.startsWith(path)) {
            allowed = false;
          }
        }
        if (trimmed.startsWith('crawl-delay:')) {
          const delay = parseInt(trimmed.split(':')[1]?.trim() ?? '0', 10);
          if (!isNaN(delay)) crawlDelay = delay;
        }
      }
    }

    robotsCache.set(domain, { allowed, crawlDelay });
    return { allowed, crawlDelay };
  } catch {
    return { allowed: true, crawlDelay: 0 };
  }
}

// ---------------------------------------------------------------------------
// 9. Unified Fetch with All Patterns
// ---------------------------------------------------------------------------

export interface FetchResult {
  ok: boolean;
  status: number;
  body: string;
  latencyMs: number;
  blocked: boolean;
  retryAfterMs?: number;
}

/**
 * Fetch a page with all borrowed techniques applied:
 * - Browser-realistic headers (Camoufox consistency)
 * - AutoThrottle delays (Scrapling)
 * - Retry-After handling (Scrapling)
 * - Block detection (Scrapling)
 * - robots.txt compliance
 * - Request timing jitter
 */
export async function smartFetch(
  url: string,
  throttle: AutoThrottle,
  options?: {
    maxRetries?: number;
    skipRobots?: boolean;
    extraHeaders?: Record<string, string>;
  },
): Promise<FetchResult> {
  const maxRetries = options?.maxRetries ?? 3;
  const domain = new URL(url).hostname;

  // robots.txt check
  if (!options?.skipRobots) {
    const robots = await checkRobotsTxt(url);
    if (!robots.allowed) {
      return { ok: false, status: 0, body: '', latencyMs: 0, blocked: true };
    }
    // Respect crawl-delay
    if (robots.crawlDelay > 0) {
      await sleep(robots.crawlDelay * 1000);
    }
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Apply throttle with jitter
    const delay = throttle.delayWithJitter(domain);
    if (delay > 0 && attempt > 0) {
      await sleep(delay * 1000);
    }

    const start = Date.now();
    try {
      const headers = buildHeaders(url, { extraHeaders: options?.extraHeaders });
      const res = await fetch(url, { headers, redirect: 'follow' });
      const body = await res.text();
      const latencyMs = Date.now() - start;

      if (isBlocked(res, body)) {
        const retryAfter = parseRetryAfter(res.headers.get('Retry-After'));
        throttle.record(domain, latencyMs, false, retryAfter * 1000);

        if (attempt < maxRetries) {
          await sleep(retryAfter * 1000);
          continue;
        }

        return { ok: false, status: res.status, body, latencyMs, blocked: true, retryAfterMs: retryAfter * 1000 };
      }

      if (!res.ok) {
        throttle.record(domain, latencyMs, false);
        if (attempt < maxRetries) continue;
        return { ok: false, status: res.status, body, latencyMs, blocked: false };
      }

      throttle.record(domain, latencyMs, true);
      return { ok: true, status: res.status, body, latencyMs, blocked: false };
    } catch (err) {
      const latencyMs = Date.now() - start;
      throttle.record(domain, latencyMs, false);
      if (attempt === maxRetries) {
        return { ok: false, status: 0, body: '', latencyMs, blocked: false };
      }
      await sleep(1000 * (attempt + 1));
    }
  }

  return { ok: false, status: 0, body: '', latencyMs: 0, blocked: false };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
