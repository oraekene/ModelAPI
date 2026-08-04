# ModelMap — sync worker

Build step 3 of the [v2 spec](../ModelMap-v2-spec.md): queue-driven ingestion of the
OpenRouter model catalog and benchmark scores into D1, on Cloudflare's free tier.

## Why it looks like this

Workers Free allows **10 ms CPU per invocation, cron triggers included**, and **1,000 KV
writes/day**. So:

- The cron handler only fetches the catalog and fans it out into queue messages. It never
  parses or normalises.
- The queue consumer handles one bounded slice per invocation.
- D1 is the source of truth. KV holds precomputed answers only (~40 keys), not per-model rows.

## Setup

```bash
npm install
wrangler d1 create modelmap          # paste the id into wrangler.toml
wrangler kv namespace create CACHE   # paste the id into wrangler.toml
wrangler queues create modelmap-sync
wrangler queues create modelmap-sync-dlq

npm run db:init                      # apply migrations/0001_init.sql
wrangler secret put OPENROUTER_API_KEY
npm run deploy
```

Only **one** credential is required: an OpenRouter API key. It covers the catalog, context
windows, pricing, free-variant detection, and Artificial Analysis + Design Arena scores
already joined to OpenRouter model identity. An Artificial Analysis key is optional.

## Endpoints

| Route | Purpose |
| :--- | :--- |
| `GET /health` | Last sync run: status, slices landed, timestamps |
| `POST /admin/sync` | Trigger a sync without waiting for cron (works from a phone) |
| `GET /admin/capabilities` | What each upstream source actually returned |

`/admin/capabilities` is the answer to "what can my API key see". The ingest worker records
which fields arrived non-null, so a tier upgrade widens the benchmark-override menu on the
next sync with no code change — and no manual `curl` probing is ever required.

**These admin routes are unauthenticated as written.** Add a shared-secret header check
before deploying anywhere reachable.

## CPU budget — measured

`npm run cpu:check [sliceSize] [iterations]` times the pure-CPU portion of one slice
(JSON parse + normalisation), excluding network and D1 round-trips.

Measured on Node, 300 iterations:

| Slice size | Payload | p95 | Verdict |
| ---: | ---: | ---: | :--- |
| 25 | 22.5 KB | 0.23 ms | default — ~40× headroom |
| 50 | 45.0 KB | 0.34 ms | fine |
| 100 | 90.1 KB | 1.22 ms | fine |
| 200 | 180.5 KB | 1.07 ms | fine |
| 400 | 361.2 KB | 4.84 ms | too close to the limit |

**Two caveats that matter more than the medians.**

First, Node is not workerd. These numbers are an order-of-magnitude signal, not a
prediction. The real check is the CPU-time column in the Workers dashboard after the first
live run.

Second, and more important: at slice size 25 the *median* was 0.089 ms but the observed
**max was 9.2 ms** — a garbage-collection pause, right at the 10 ms wall. Tail latency, not
median, is what breaks a hard per-invocation CPU limit. This is the argument for keeping
`SLICE_SIZE = 25` even though 200 fits comfortably on the median: the headroom is there to
absorb GC outliers, not because the parsing is slow.

If the dashboard shows CPU-time errors in production, halve `SLICE_SIZE` in `wrangler.toml`
(no redeploy of logic needed). If that does not resolve it, stop tuning — see below.

## The $5 escape hatch

Workers Paid raises CPU to 30 s default and 15 min for cron triggers, which makes the
entire chunking layer unnecessary: the cron handler could do the whole sync inline. The
queue consumer logic stays reusable either way.

Build chunked first. If the chunked pipeline proves fiddly in practice, paying $5/month is
the correct trade rather than fighting the free tier.

## What is deliberately not here yet

- **Real harness rows.** Everything currently lands as the `openrouter-api` harness. The
  `opencode-cli` / `claude-web` / `cursor` rows come from the step-7 quota scraper, which
  knows which models each surface actually serves.
- **Terminal-Bench harness scores** (step 6). Until then every score row carries
  `score_scope = 'model_only_inferred'`.
- **Rank computation and KV answer blobs** (step 4).

## Attribution

The `/benchmarks` response includes a `citation` field with the exact required attribution
string. The worker caches it under `citation:{source}` in KV. Render it verbatim rather
than hardcoding wording — the upstream string is authoritative and may change.

## Admin authentication

`/admin/*` requires a shared secret in the `X-ModelMap-Admin` header. `/health` stays open
so uptime checks work without the secret.

```bash
# generate and store a secret
openssl rand -base64 32
wrangler secret put ADMIN_SECRET
```

Then from any HTTP client, including a phone:

```
POST https://modelmap.<subdomain>.workers.dev/admin/sync
X-ModelMap-Admin: <secret>
```

Two properties worth noting. The comparison is **constant-time** — a naive `===`
short-circuits on the first differing byte, which leaks the secret one character at a time
to anyone who can measure response latency. And an unset or short (<16 char) secret
**fails closed with a 503** rather than allowing access; a missing binding is a
misconfiguration, not an invitation.

| Route | Auth | Purpose |
| :--- | :--- | :--- |
| `GET /health` | open | Last sync run status |
| `POST /admin/sync` | secret | Trigger a full run from a phone |
| `GET /admin/capabilities` | secret | What each upstream source returned |
| `GET /admin/answer?category=coding&tier=free` | secret | Inspect a computed blob |

## Step 4 — ranking

After ingestion, `finalise` fans out one queue message per `(category, tier)` pair. Each
computes a ranking and writes exactly one KV key.

Categories come from the `category_benchmarks` table, not from code — adding a row adds a
category with no redeploy.

### KV write budget

7 categories × 2 tiers = **14 keys**, refreshed 4×/day = 56 writes/day, plus ~24 citation
writes. About **80/day against the 1,000 free-tier limit**. Each new category costs 8
writes/day, so there is room for roughly 100 categories before writes bind.

### Scoring decisions

Run `npm test` for the scoring test suite (25 assertions, no framework required).

**Missing terms are dropped and weights renormalised**, not stubbed. Stubbing `K = 100`
would silently award every offering full marks on the term meant to discriminate; stubbing
`K = 0` would drag a strong model from 80 to 44 and make it look mediocre. Renormalising
means the score reads as "best answer given what we actually measured", and `basis` reports
which terms contributed. When the quota scrapers land in step 7, `K` starts contributing
automatically with no formula change.

**Normalisation is scale-aware.** This was a real bug caught by the tests. Naive min-max
against the candidate set stretches whatever spread is present to fill 0–100 — so two
models 7 points apart on a 0–100 index appeared 100 points apart when they were the only
two candidates, and the bottom candidate always scored zero regardless of merit. Now:

1. **Known scale** (AA indices 0–100, Terminal-Bench 0–1) → normalise against the true
   range. Absolute and stable; a model's score does not move because different competitors
   were in the query.
2. **Unknown scale, ≥5 candidates** (Design Arena ELO) → min-max within the set.
3. **Unknown scale, <5 candidates** → everything returns 50, letting other terms decide.
   Refusing to rank beats inventing a 100-point gap from three ELO points.

The end-to-end test confirms the intended behaviour in both directions: a model 4 points
behind on benchmark but with 20× the daily quota **does** overtake (74.9 vs 74.4), while a
model 45 points behind **does not** get rescued by quota. That asymmetry is the point.

### Still inert until later steps

`H` (harness delta) is null everywhere until Terminal-Bench lands in step 6, and `K` is
null until the quota scrapers land in step 7. Both redistribute their weight automatically,
so today's rankings are effectively pure benchmark order — correct, and honestly labelled
via `basis` and `score_scope`.

## Step 5 — request path and board

`GET /` serves the UI. `GET /api/recommend` serves JSON. Both are public; `/admin/*`
remains behind the secret.

```
GET /api/recommend?task=refactor+this+module&size=medium&tier=free&exec=0&files=0
```

The path does exactly **one KV read** and no upstream calls. Query state lives in the URL,
so a result is shareable and the back button works.

### Classification is a static table, not KV

§8 of the spec put the keyword table in KV. A module constant is strictly better: zero KV
reads, zero latency, versioned with the code. KV is for data that changes between deploys;
this does not.

Ambiguity uses **two gates** rather than one ratio. With coarse integer weights, raw score
ratios are chunky — 3-vs-2 near-ties are common — so a single threshold either never fires
or fires constantly. An alternate category is reported when the runner-up reaches 60% of
the winner **and** the winner is not decisive (score < 6). So "write a script to chart the
data" returns `dataviz / coding`, while "debug this typescript function and fix the failing
test" returns `coding` alone.

### Two bugs the tests caught

**Agent size was modelled as a 200k single payload.** That filtered out every
normal-context model and left only million-token models on the board — exactly backwards.
A long agent run is many calls each carrying a working set, not one enormous prompt. Long
runs are usually served by fast, cheap, ordinary-context models called repeatedly.

Fixed by separating the axes: `SIZE_TOKENS.agent` is now 48k (tokens per call) while
`estimateCalls('agent')` stays at 150. Together they say what is actually true — an agent
run needs a moderate window and a large quota. The test now asserts that a long run keeps
normal-context models *and* puts the quota-rich one on top (`capped/model` drops 92.1 → 74.3
between a small task and an agent run, while `roomy/model` holds).

**Large payloads still filter correctly** — a 120k payload excludes a 128k-window model,
because `fitsContext` reserves 25% for the response.

### Re-ranking at request time

The stored blob is ranked assuming a medium task. The request path re-scores against the
user's actual size hint, which changes the quota picture: a 50/day cap is fine for a
3-call question and poor for a 150-call run. This is cheap because `quality_norm` is
retained in the blob — no re-normalising, no D1.

### Design

The board is a departures board, because routing a task to a model is a dispatch problem
and that vernacular already carries what this data needs: a **platform assignment** (the
medium), **track order** (rank), and **status chips** (provenance, context, quota). Enamel
transit-sign palette, Barlow Condensed for signage rows, IBM Plex Mono for anything
numeric. Row reveal is staggered and respects `prefers-reduced-motion`.

Provenance is surfaced per row in one word — `harness measured` in signal green versus
`model only` in amber — so a CLI recommendation carries whether the number was measured in
that harness or extrapolated. The `basis` chip names which scoring terms actually
contributed, which today reads `quality` or `quality + quota`.

### Tests

`npm test` runs both suites: 25 scoring assertions and 33 request-path assertions, plain
Node, no framework.

## Step 6 — Terminal-Bench

The source that makes `harness_measured` real. It is the only public dataset scoring a
**model and its harness together**, which is the distinction the `offerings` schema exists
to capture.

### Budget: it costs nothing

The leaderboard is **server-rendered**. All 142 entries arrive through a plain `fetch()`,
so this consumes **zero Browser Rendering time** and never touches the 10 min/day
allowance. Two fetches (2.0 and 2.1) per sync. Don't reach for headless rendering here.

### Why this step matters — the numbers

Claude Opus 4.5 on the live 2.0 board, same model, eight harnesses:

| Harness | Accuracy | H |
| :--- | ---: | ---: |
| Droid | 63.1% | 100 |
| Letta Code | 59.1% | 79 |
| Mux | 58.4% | 73 |
| Terminus 2 | 57.8% | 68 |
| Goose | 54.3% | 38 |
| Claude Code | 52.1% | 15 |
| OpenHands | 51.9% | 14 |
| OpenCode | 51.7% | 12 |

An **11.4-point spread on an identical model**. That is the entire argument for ranking
`(model × harness × plan)` rather than models: a board that ranked Opus 4.5 as a single
row would be answering a question nobody asked.

`H` is the delta from the model's own mean, scaled across its observed spread — not raw
accuracy, which mostly tracks model quality that `Q` already covers. A model measured in
only one harness scores a neutral **50**, not an unearned 100.

### Name matching is the hard part

Terminal-Bench publishes display names; OpenRouter uses slugs. The live data contains
token reordering (`Claude 4.6 Opus` vs `Claude Opus 4.6`), case and separator variants
(`minimax-m2.5` / `Minimax m2.5` / `MiniMax M2.5`), and adjacent versions that must never
be conflated.

Names are compared as **token sets** so ordering doesn't matter, with an **exact version
gate**. The version check is what stops Opus 4.5 matching Opus 4.6 — a failure that would
silently attribute one model's harness score to another. Unmatched names return `null`
rather than a near-miss: a missing harness score is a small loss, a wrong one corrupts the
board.

Rows submitted under the model name `Multiple` (several harnesses route internally) are
**dropped**, not guessed at. Duplicate `(agent, model)` submissions collapse to the best
score.

### Failing loudly

If the page parses to fewer than 10 rows the ingest **throws**. The board has ~142 entries;
a collapse means the markup changed, not that every agent was delisted. The message retries,
the run is marked `partial` on `/health`, and existing harness scores are left untouched —
so the board keeps serving the last good data instead of silently losing its deltas.

`GET /admin/terminalbench` returns the match rate and the list of unmatched names. A sudden
jump in unmatched names means the matcher regressed; a slow drift means new models that
OpenRouter doesn't carry, which is legitimate.

### The placeholder this replaced

Step 4 set `harness = quality_norm` whenever `score_scope` was `harness_measured` — a
stand-in that made H a copy of Q and carried no information. It now joins a real
Terminal-Bench row for the exact `(model, harness)` pair, and `score_scope` is **derived**
from whether that measurement exists rather than being asserted upstream.

### Still uncovered

Cursor, Cline, and chat interfaces have no public harness measurement and stay
`model_only_inferred` indefinitely. The UI labels this per row.

## Step 7 — quota pools

The requirement was: never hardcode native free tiers, always research them. This step
does that, and the research turned up a modelling error in the spec.

### Quota is a property of the platform, not the model

v2 §4 put `quota_value` on `offerings`, implying each model carries its own allowance.
OpenRouter's own docs are explicit that this is wrong: *"Making additional accounts or API
keys will not affect your rate limits, as we govern capacity globally."* Every `:free`
model draws from **one shared daily bucket** — spending it on DeepSeek leaves none for Qwen.

So `quota_pools` is now a first-class table and offerings point at it.

**The consequence for scoring, stated plainly: `K` does not discriminate between models on
the same platform.** Their quota is identical by construction. It discriminates *across*
platforms — OpenRouter free vs a 14,400/day platform — and across **account states**. That
is narrower than the spec implied, and it is what `K` was always actually measuring.

### The account-state swing is bigger than any model difference

From OpenRouter's rate-limit documentation:

| Credits purchased (lifetime) | Requests/min | Requests/day |
| :--- | ---: | ---: |
| Under $10 | 20 | **50** |
| $10 or more | 20 | **1,000** |

A **twentyfold** daily difference from account history alone, and the unlock is permanent
even if the balance later returns to zero. No model swap the board could recommend comes
close to that, so it is surfaced once above the results rather than buried per row.

### No scraping needed for the pool that matters

`GET /api/v1/key` returns `is_free_tier` — whether the account has ever purchased credits —
alongside daily usage. That is strictly better than scraping a docs page: it reports what
**this account** actually gets rather than the documented default, and it cannot drift.

Sources are tiered cheapest-first: **live** (provider API), **Tier A** (plain fetch of a
server-rendered docs page), **Tier B** (Browser Rendering, JS-gated pages only). Steps 6
and 7 both came in at zero browser time, so the full 10 min/day allowance remains unspent.

### Third-party sources conflict — only the provider settles it

Guides variously claim 50, 200 and 1,000 requests/day for the same tier. `quota_observations`
records every figure seen with its source URL, and `sourcesDisagree()` lowers confidence
when values differ by 2x or more rather than silently picking one.

Reconciliation takes the **smallest** plausible figure per unit, because a free allowance
is never the largest number on a pricing page. The bias is deliberate: under-promising costs
a slightly conservative ranking, over-promising sends someone into a 429 mid-task.

### The extractor bug, and why anchoring direction matters

The first implementation found numbers and scanned *forward* for a unit phrase. On the real
sentence *"accounts with less than $10 purchased get 50 requests per day"* it returned
**10** — the price threshold, not the allowance. It also missed figures entirely when two
rates shared a sentence with no terminator between them, silently reporting only the paid
tier.

A rate figure always **precedes** its unit, so the unit phrase is now the anchor and the
scan runs backwards to the nearest number. Currency-prefixed figures are rejected outright:
`$10` is a price, never an allowance. Both cases are locked in as regression tests.

### Failure behaviour

A pool that cannot be verified degrades to `confidence = 'stale'` and **keeps its previous
value** rather than being nulled. A stale number with visible age beats no number, provided
the staleness is surfaced — which the board does, per row. `GET /admin/quota` shows each
pool's value, source method, and verification age.

### Tests

`npm test` now runs four suites: 25 scoring, 33 request-path, 37 Terminal-Bench, 25 quota —
**120 assertions**, plain Node, no framework.

## Steps 8 & 9 — Telegram bot, identity, alerts

### Setup

```bash
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_WEBHOOK_SECRET   # openssl rand -hex 32

curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d "url=https://<worker>/telegram/webhook" \
  -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

Set `PUBLIC_URL` in `wrangler.toml` after the first deploy so magic links resolve.

### Commands

| Command | Effect |
| :--- | :--- |
| *(any text)* | Routed as a task; returns the top 3 |
| `/link` | Issues a single-use URL connecting this chat to the browser |
| `/settings` | Shows current preferences |
| `/set key value` | Changes one whitelisted setting |
| `/alerts on\|off` | Toggles rank-change alerts |

### Identity — one row, two surfaces

The bot is the identity anchor. `/link` mints a 256-bit single-use token; opening the URL
sets an `HttpOnly; Secure; SameSite=Strict` cookie bound to the same `user_id`. Both
surfaces then read and write one `user_preferences` row, so a change in Telegram shows up
on the web and vice versa. No auth provider, no email, no password. Anonymous web visitors
get defaults with no persistence.

Security properties worth naming, since this token is a bearer credential for the account's
settings:

- **Unguessable.** `crypto.getRandomValues`, not `Math.random`.
- **Single-use and expiring**, enforced in one conditional `UPDATE` rather than
  read-then-write — two simultaneous redemptions cannot both succeed.
- **Format-gated** before any database lookup, so malformed input never reaches a query.

### Webhook authentication

The webhook URL is public, so it is authenticated by the secret token Telegram echoes in
`X-Telegram-Bot-Api-Secret-Token`, compared in constant time. An unset or short secret
**fails closed**. Path obscurity is not authentication — without this check, anyone who
guessed the URL could forge updates and drive the bot.

The handler always returns 200 to Telegram even on internal failure: a non-200 makes
Telegram retry the same update indefinitely. Failures are logged instead.

### `/set` cannot reach arbitrary columns

Settings go through a whitelist mapping key → column name → parser. Column names come from
that table, never from user input, so no interpolation of user text into SQL is possible.
Unknown keys are refused with the valid list.

### The margin rule is what makes alerts survivable

An alert fires only when #1 changes **and** the margin exceeds the user's threshold
(default 3%), plus a 12-hour per-route cooldown. Without the margin gate, two near-tied
models trade places on every sync and the bot becomes noise the user mutes — at which point
the feature is worse than not having shipped it. Tests assert both directions: a 1.4% swap
stays quiet, a 14% change fires.

### Tests

`npm test` runs five suites — 25 scoring, 33 request-path, 37 Terminal-Bench, 25 quota,
34 bot/identity/alerts — **154 assertions**, plain Node, no framework.

---

## Status

Steps 1–9 complete. Every term in the scoring formula now has real data behind it:

| Term | Source | State |
| :--- | :--- | :--- |
| `Q` quality | OpenRouter `/benchmarks` (AA + Design Arena) | live |
| `H` harness | Terminal-Bench 2.0 / 2.1 | live, CLI harnesses only |
| `K` quota | OpenRouter `/key` live + docs scraping | live |
| `V` speed | — | not yet wired; weight redistributes |

Remaining known gaps are in the spec's §11: chat-harness quality has no public measurement
and stays `model_only_inferred`; Terminal-Bench has no API, so the scraper is expected to
break and fails loudly by design.
