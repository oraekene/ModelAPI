/**
 * Tests for web crawlers (OpenRouter, Groq, Together, Fireworks, DeepSeek, HF).
 *
 *   node scripts/test-web-crawlers.mjs
 */

let passed = 0, failed = 0;
const check = (n, c, d = '') => {
  if (c) { passed++; console.log(`  PASS  ${n}`); }
  else { failed++; console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`); }
};

class MockDB {
  constructor() { this._store = new Map(); this._writes = []; }
  prepare(sql) {
    const db = this;
    return { bind(...params) {
      return {
        async run() { db._writes.push({ sql, params }); if (sql.includes('INSERT')) db._store.set(params[0], params.slice(1)); return { success: true }; },
        async first() { return db._store.get(params[0]) ?? null; },
      };
    }};
  }
  async batch(stmts) { for (const s of stmts) await s.run(); return { success: true }; }
}

// Mock fetch to return fake HTML
const originalFetch = globalThis.fetch;
function mockFetch(html) {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: new Map(),
    text: async () => html,
  });
}
function restoreFetch() { globalThis.fetch = originalFetch; }

const OFFERING_SQL = `INSERT INTO offerings`;

// --- OpenRouter Crawler ---
console.log('OpenRouter Crawler');
{
  const { OpenRouterCrawler } = await import('../src/scrapers/openrouter-crawl.ts');
  const crawler = new OpenRouterCrawler();

  mockFetch(`
    <html><body>
    <script id="__NEXT_DATA__" type="application/json">
    {"props":{"pageProps":{"models":[
      {"id":"openai/gpt-4o","context_length":128000,"pricing":{"prompt":"0.005","completion":"0.015"},"supported_parameters":["tools"]},
      {"id":"anthropic/claude-3.5-sonnet","context_length":200000,"pricing":{"prompt":"0.003","completion":"0.015"}},
      {"id":"meta-llama/llama-3.1-8b-instruct:free","context_length":131072,"pricing":{"prompt":"0","completion":"0"}}
    ]}}</script>
    </body></html>
  `);

  check('openrouter: id is correct', crawler.id === 'openrouter-crawl');
  check('openrouter: category is inference', crawler.category === 'inference');
  const models = crawler.parseHtml('https://openrouter.ai/models', (await import('fs')).readFileSync ? '' : '');
  // Test with mock HTML directly
  const html = `<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"models":[{"id":"openai/gpt-4o","context_length":128000,"pricing":{"prompt":"0.005","completion":"0.015"},"supported_parameters":["tools"]},{"id":"meta-llama/llama-3.1-8b-instruct:free","context_length":131072,"pricing":{"prompt":"0","completion":"0"}}]}}}</script>`;
  const parsed = crawler.parseHtml('https://openrouter.ai/models', html);
  check('openrouter: parses models from __NEXT_DATA__', parsed.length === 2);
  check('openrouter: first model is openai/gpt-4o', parsed[0]?.modelId === 'openrouter/openai/gpt-4o');
  check('openrouter: free model detected', parsed[1]?.isFree === 1);
  check('openrouter: context window extracted', parsed[0]?.contextWindow === 128000);
  check('openrouter: tools support detected', parsed[0]?.supportsTools === 1);
  restoreFetch();
}

// --- Groq Crawler ---
console.log('Groq Crawler');
{
  const { GroqCrawler } = await import('../src/scrapers/groq-crawl.ts');
  const crawler = new GroqCrawler();
  check('groq: id is correct', crawler.id === 'groq-crawl');

  const html = `
    <html><body>
    <h2>llama-3.3-70b-versatile</h2>
    <h2>mixtral-8x7b-32768</h2>
    <h2>gemma2-9b-it</h2>
    <code>llama-3.1-8b-instant</code>
    <code>qwen-qwq-32b</code>
    </body></html>
  `;
  const parsed = crawler.parseHtml('https://console.groq.com/docs/models', html);
  check('groq: finds models in HTML', parsed.length >= 3);
  check('groq: model IDs start with groq/', parsed.every(m => m.modelId.startsWith('groq/')));
  check('groq: all free', parsed.every(m => m.isFree === 1));
}

// --- Together Crawler ---
console.log('Together Crawler');
{
  const { TogetherCrawler } = await import('../src/scrapers/together-crawl.ts');
  const crawler = new TogetherCrawler();
  check('together: id is correct', crawler.id === 'together-crawl');

  const html = `
    <html><body>
    <div>model_id: "meta-llama/Llama-3.3-70B-Instruct-Turbo"</div>
    <div>model_id: "deepseek-ai/DeepSeek-V3"</div>
    <div>model_id: "Qwen/Qwen2.5-72B-Instruct-Turbo"</div>
    </body></html>
  `;
  const parsed = crawler.parseHtml('https://www.together.ai/models', html);
  check('together: finds models', parsed.length >= 2);
  check('together: model IDs start with together/', parsed.every(m => m.modelId.startsWith('together/')));
}

// --- DeepSeek Crawler ---
console.log('DeepSeek Crawler');
{
  const { DeepSeekCrawler } = await import('../src/scrapers/deepseek-crawl.ts');
  const crawler = new DeepSeekCrawler();
  check('deepseek: id is correct', crawler.id === 'deepseek-crawl');

  const html = `<html><body>
    <div>Try DeepSeek-V3 now</div>
    <div>DeepSeek-R1 reasoning model</div>
    <div>deepseek-chat is free</div>
  </body></html>`;
  const parsed = crawler.parseHtml('https://chat.deepseek.com', html);
  check('deepseek: finds models', parsed.length >= 2);
  check('deepseek: model IDs start with deepseek/', parsed.every(m => m.modelId.startsWith('deepseek/')));
}

// --- HuggingFace Crawler ---
console.log('HuggingFace Crawler');
{
  const { HuggingFaceCrawler } = await import('../src/scrapers/hf-crawl.ts');
  const crawler = new HuggingFaceCrawler();
  check('hf: id is correct', crawler.id === 'hf-crawl');

  const html = `<html><body>
    <a href="/meta-llama/Llama-3.1-8B" class="model-card">Llama</a>
    <a href="/mistralai/Mistral-7B">Mistral</a>
    <a href="/bert-base-uncased">BERT</a>
  </body></html>`;
  const parsed = crawler.parseHtml('https://huggingface.co/models', html);
  check('hf: finds models', parsed.length >= 2);
  check('hf: model IDs start with hf/', parsed.every(m => m.modelId.startsWith('hf/')));
  check('hf: all free', parsed.every(m => m.isFree === 1));
}

// --- Generic Crawler ---
console.log('Generic Crawler');
{
  const { GenericCrawler } = await import('../src/scrapers/generic-crawl.ts');
  const crawler = new GenericCrawler();
  crawler.configure(['https://example.com/models'], 'example', 'https://example.com');
  check('generic: id is correct', crawler.id === 'generic-crawl');

  const html = `<html><body>
    <h1>Available Models</h1>
    <table>
      <tr><td>gpt-4-turbo</td><td>$10/1M tokens</td></tr>
      <tr><td>claude-3-opus</td><td>$15/1M tokens</td></tr>
      <tr><td>llama-3-70b</td><td>Free</td></tr>
    </table>
  </body></html>`;
  const parsed = crawler.parseHtml('https://example.com/models', html);
  check('generic: finds models from table', parsed.length >= 2);
  check('generic: model IDs start with platform/', parsed.every(m => m.modelId.startsWith('example/')));
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
