/**
 * Groq Web Crawler — scrapes https://console.groq.com/docs/models
 *
 * Groq's model documentation page lists all available models with context
 * windows and rate limits. No API key needed.
 */

import { WebCrawlerScraper, type CrawledModel } from './web-crawler';

export class GroqCrawler extends WebCrawlerScraper {
  readonly id = 'groq-crawl';
  readonly category = 'inference' as const;
  readonly displayName = 'Groq (Web Crawl)';

  protected crawlUrls(): string[] {
    return ['https://console.groq.com/docs/models'];
  }

  protected parseHtml(_url: string, html: string): CrawledModel[] {
    const models: CrawledModel[] = [];

    // Groq's docs page has model info in structured tables.
    // Look for model names in table rows or headings.
    const modelPatterns = [
      // Pattern: "llama-3.3-70b-versatile" or "mixtral-8x7b-32768"
      /(?:model|name)["']?\s*[:=]\s*["']([a-z0-9-]+(?:-[a-z0-9]+)*)/gi,
      // Pattern: headings like "## Llama 3.3 70B"
      /##\s+([A-Za-z0-9.]+\s+[A-Za-z0-9.]+(?:\s+[A-Za-z0-9.]+)?)/g,
      // Pattern: code blocks with model IDs
      /<code[^>]*>([a-z0-9-]+(?:\/[a-z0-9-]+)+)<\/code>/gi,
      // Pattern: model IDs in links
      /href=["'][^"']*#([a-z0-9-]+)["']/gi,
    ];

    const seen = new Set<string>();

    for (const pattern of modelPatterns) {
      let match;
      while ((match = pattern.exec(html)) !== null) {
        const raw = match[1].toLowerCase().replace(/\s+/g, '-');
        // Filter out non-model strings
        if (raw.length < 5 || raw.includes('http') || raw.includes('api')) continue;
        if (seen.has(raw)) continue;
        seen.add(raw);

        // Try to extract context window from nearby text
        const contextMatch = html.match(new RegExp(`${raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^<]{0,200}?(\\d[\\d,]+)\\s*(?:tokens|context)`, 'i'));
        const contextWindow = contextMatch
          ? parseInt(contextMatch[1].replace(/,/g, ''), 10)
          : null;

        models.push({
          modelId: `groq/${raw}`,
          harnessId: 'groq-crawl',
          planId: 'free',
          medium: 'inference',
          contextWindow: isNaN(contextWindow!) ? null : contextWindow,
          supportsVision: 0,
          supportsTools: raw.includes('tool') || raw.includes('function') ? 1 : 0,
          isFree: 1,
          pricePrompt: null,
          priceCompletion: null,
          accessUrl: `https://console.groq.com/docs/models#${raw}`,
        });
      }
    }

    // Also look for the specific model table format Groq uses.
    // They list models like: llama-3.3-70b-versatile, mixtral-8x7b-32768, etc.
    const knownGroqModels = [
      'llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'llama-3.1-70b-versatile',
      'llama-3.2-1b-preview', 'llama-3.2-3b-preview', 'llama-3.2-11b-vision-preview',
      'llama-3.2-90b-vision-preview', 'mixtral-8x7b-32768', 'gemma2-9b-it',
      'gemma-7b-it', 'phi-3-mini-128k-instruct', 'qwen-qwq-32b',
    ];

    for (const model of knownGroqModels) {
      if (!seen.has(model) && html.includes(model)) {
        seen.add(model);
        models.push({
          modelId: `groq/${model}`,
          harnessId: 'groq-crawl',
          planId: 'free',
          medium: 'inference',
          contextWindow: parseInt(model.match(/(\d+)k/)?.[1] ?? '0', 10) * 1024 || null,
          supportsVision: model.includes('vision') ? 1 : 0,
          supportsTools: 1,
          isFree: 1,
          pricePrompt: null,
          priceCompletion: null,
          accessUrl: `https://console.groq.com/docs/models#${model}`,
        });
      }
    }

    return models;
  }
}
