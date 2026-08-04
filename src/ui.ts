/**
 * Web UI.
 *
 * Design direction: a departures board. Routing a task to a model is
 * structurally a dispatch problem — "which train do I take" — and that
 * vernacular already carries the exact vocabulary this data needs: a platform
 * assignment (the medium), track order (rank), and status chips (provenance
 * and quota confidence). Enamel-sign palette, condensed signage type, monospace
 * for anything numeric.
 *
 * Served as a single self-contained document. State lives in the URL so a
 * result is shareable and the back button works.
 */

export const INDEX_HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ModelMap — departures</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;500;600&family=Barlow:wght@400;500&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root {
    --ink:    #0E1C24;
    --panel:  #162A35;
    --rule:   #27424F;
    --bone:   #E9E4D6;
    --dim:    #7E97A3;
    --signal: #4EC08C;
    --amber:  #DFA23F;
    --board-gap: clamp(0.75rem, 2vw, 1.25rem);
  }

  * { box-sizing: border-box; }

  body {
    margin: 0;
    background: var(--ink);
    color: var(--bone);
    font-family: 'Barlow', system-ui, sans-serif;
    font-size: 16px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }

  .wrap {
    max-width: 46rem;
    margin: 0 auto;
    padding: var(--board-gap);
  }

  /* ---- masthead ---- */
  header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
    padding-bottom: 0.6rem;
    border-bottom: 2px solid var(--rule);
  }
  .mark {
    font-family: 'Barlow Condensed', sans-serif;
    font-weight: 600;
    font-size: 1.6rem;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    margin: 0;
  }
  .mark span { color: var(--signal); }
  .stamp {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 0.68rem;
    color: var(--dim);
    letter-spacing: 0.04em;
    text-align: right;
  }

  /* ---- query ---- */
  form { margin: 1.4rem 0 0; }
  label.field { display: block; }
  .eyebrow {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 0.66rem;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--dim);
    display: block;
    margin-bottom: 0.4rem;
  }
  textarea {
    width: 100%;
    min-height: 4.5rem;
    resize: vertical;
    background: var(--panel);
    border: 1px solid var(--rule);
    color: var(--bone);
    font-family: inherit;
    font-size: 1rem;
    padding: 0.7rem 0.8rem;
    border-radius: 2px;
  }
  textarea:focus-visible,
  select:focus-visible,
  button:focus-visible {
    outline: 2px solid var(--signal);
    outline-offset: 2px;
  }

  .controls {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-top: 0.7rem;
    align-items: flex-end;
  }
  .ctl { flex: 1 1 7rem; min-width: 7rem; }
  select {
    width: 100%;
    background: var(--panel);
    border: 1px solid var(--rule);
    color: var(--bone);
    font-family: 'Barlow', sans-serif;
    font-size: 0.9rem;
    padding: 0.5rem;
    border-radius: 2px;
  }
  button.go {
    flex: 0 0 auto;
    background: var(--signal);
    color: var(--ink);
    border: 0;
    font-family: 'Barlow Condensed', sans-serif;
    font-weight: 600;
    font-size: 1rem;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    padding: 0.62rem 1.4rem;
    border-radius: 2px;
    cursor: pointer;
  }
  button.go:hover { filter: brightness(1.1); }
  button.go:disabled { opacity: 0.5; cursor: progress; }

  /* ---- platform assignment: the signature element ---- */
  .platform {
    margin-top: 1.6rem;
    border: 1px solid var(--rule);
    border-left: 4px solid var(--signal);
    background: var(--panel);
    padding: 0.85rem 1rem;
  }
  .platform .assigned {
    font-family: 'Barlow Condensed', sans-serif;
    font-weight: 600;
    font-size: 1.9rem;
    line-height: 1.05;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
  .platform .why { color: var(--dim); font-size: 0.86rem; margin-top: 0.2rem; }

  /* ---- board ---- */
  .board { margin-top: 1.1rem; border-top: 1px solid var(--rule); }
  .row {
    display: grid;
    grid-template-columns: 2.1rem 1fr auto;
    gap: 0.7rem;
    align-items: start;
    padding: 0.8rem 0.15rem;
    border-bottom: 1px solid var(--rule);
  }
  .track {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 0.9rem;
    color: var(--ink);
    background: var(--bone);
    text-align: center;
    padding: 0.1rem 0;
    border-radius: 2px;
  }
  .row:first-child .track { background: var(--signal); }
  .name {
    font-family: 'Barlow Condensed', sans-serif;
    font-weight: 600;
    font-size: 1.22rem;
    letter-spacing: 0.03em;
    line-height: 1.15;
    word-break: break-word;
  }
  .via { color: var(--dim); font-size: 0.8rem; margin-top: 0.1rem; }
  .score {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 1.05rem;
    text-align: right;
    white-space: nowrap;
  }
  .score small { display: block; font-size: 0.6rem; color: var(--dim); letter-spacing: 0.08em; }

  .chips { grid-column: 2 / -1; display: flex; flex-wrap: wrap; gap: 0.35rem; margin-top: 0.4rem; }
  .chip {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 0.6rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    padding: 0.15rem 0.42rem;
    border: 1px solid var(--rule);
    color: var(--dim);
    border-radius: 2px;
  }
  .chip.measured { color: var(--signal); border-color: var(--signal); }
  .chip.inferred { color: var(--amber); border-color: var(--amber); }
  .chip a { color: inherit; }

  /* ---- states ---- */
  .notice, .empty {
    margin-top: 1.2rem;
    padding: 0.9rem 1rem;
    border: 1px dashed var(--rule);
    color: var(--dim);
    font-size: 0.9rem;
  }
  footer {
    margin-top: 2rem;
    padding-top: 0.8rem;
    border-top: 1px solid var(--rule);
    font-family: 'IBM Plex Mono', monospace;
    font-size: 0.64rem;
    color: var(--dim);
    line-height: 1.7;
  }
  footer a { color: var(--dim); }

  @media (prefers-reduced-motion: no-preference) {
    .row { animation: arrive 260ms ease-out backwards; }
    @keyframes arrive {
      from { opacity: 0; transform: translateY(-4px); }
      to   { opacity: 1; transform: none; }
    }
  }
</style>
</head>
<body>
<div class="wrap">

  <header>
    <h1 class="mark">Model<span>Map</span></h1>
    <div class="stamp" id="stamp">awaiting query</div>
  </header>

  <form id="q">
    <label class="field">
      <span class="eyebrow">Describe the task</span>
      <textarea id="task" placeholder="Refactor a TypeScript module and fix the failing tests"></textarea>
    </label>

    <div class="controls">
      <div class="ctl">
        <span class="eyebrow">Payload</span>
        <select id="size">
          <option value="small">Small · one question</option>
          <option value="medium" selected>Medium · a few files</option>
          <option value="large">Large · whole project</option>
          <option value="agent">Agent · long run</option>
        </select>
      </div>
      <div class="ctl">
        <span class="eyebrow">Needs</span>
        <select id="needs">
          <option value="none" selected>Nothing special</option>
          <option value="files">Writes files</option>
          <option value="exec">Shell / OS access</option>
        </select>
      </div>
      <div class="ctl">
        <span class="eyebrow">Cost</span>
        <select id="tier">
          <option value="free" selected>Free only</option>
          <option value="all">All models</option>
        </select>
      </div>
      <div class="ctl">
        <span class="eyebrow">Quality</span>
        <select id="quality">
          <option value="benchmark" selected>Benchmark</option>
          <option value="share">Community use</option>
        </select>
      </div>
      <button class="go" id="go" type="submit">Route</button>
    </div>
  </form>

  <div id="out"></div>

  <footer id="attrib"></footer>
</div>

<script>
(function () {
  const $ = (id) => document.getElementById(id);
  const out = $('out'), stamp = $('stamp'), attrib = $('attrib');

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const STALE_H = 24;

  function prefs() {
    const m = /(?:^|;\s*)mm_prefs=([^;]+)/.exec(document.cookie);
    if (!m) return {};
    const out = {};
    decodeURIComponent(m[1]).split('&').forEach((pair) => {
      const i = pair.indexOf('=');
      if (i > 0) out[pair.slice(0, i)] = pair.slice(i + 1);
    });
    return out;
  }

  function ageHours(iso) {
    const t = Date.parse(iso);
    return isNaN(t) ? NaN : (Date.now() - t) / 36e5;
  }

  function quotaChip(o) {
    if (o.quota_value == null) return '<span class="chip">quota unknown</span>';
    const unit = String(o.quota_unit || '').replace(/_/g, ' ');
    const stale = o.quota_confidence === 'stale';
    const live = o.quota_confidence === 'live';
    // "shared" is load-bearing: on OpenRouter every free model draws from ONE
    // bucket, so this allowance is not per-model.
    const shared = o.quota_shared ? ' · shared' : '';
    const cls = stale ? ' inferred' : live ? ' measured' : '';
    return '<span class="chip' + cls + '">' + esc(o.quota_value) + ' ' + esc(unit) +
      shared + (stale ? ' · stale' : '') + '</span>';
  }

  function ctxChip(o) {
    if (o.context_window == null) return '';
    const k = o.context_window >= 1e6
      ? (o.context_window / 1e6).toFixed(1) + 'M'
      : Math.round(o.context_window / 1000) + 'k';
    return '<span class="chip">' + k + ' context</span>';
  }

  function row(o, i) {
    const measured = o.score_scope === 'harness_measured';
    const link = o.access_url
      ? '<a href="' + esc(o.access_url) + '" target="_blank" rel="noopener">open</a>'
      : '';
    return '<div class="row" style="animation-delay:' + (i * 45) + 'ms">' +
      '<div class="track">' + (i + 1) + '</div>' +
      '<div><div class="name">' + esc(o.model_id) + '</div>' +
      '<div class="via">via ' + esc(o.harness_id) + ' · ' + esc(o.plan_id) + '</div></div>' +
      '<div class="score">' + o.score.toFixed(1) + '<small>score</small></div>' +
      '<div class="chips">' +
        '<span class="chip ' + (measured ? 'measured' : 'inferred') + '">' +
          (measured ? 'harness measured' : 'model only') + '</span>' +
        usageChip(o) + ctxChip(o) + quotaChip(o) +
        '<span class="chip">' + esc(o.basis.join(' + ')) + '</span>' +
        (link ? '<span class="chip">' + link + '</span>' : '') +
      '</div></div>';
  }

  function usageChip(o) {
    // A model with actual usage rows earns the share term; absent usage reads
    // as no signal, and we say so instead of pretending.
    if (o.usage_tokens == null) return '';
    return '<span class="chip">community use</span>';
  }

  function render(d) {
    stamp.textContent = d.classification.category.replace(/_/g, ' ') +
      (d.classification.alternate ? ' / ' + d.classification.alternate.replace(/_/g, ' ') : '') +
      ' · ' + (d.quality === 'share' ? 'ranked by community use' : d.benchmark || 'no benchmark');

    let html = '<div class="platform">' +
      '<span class="eyebrow">Platform</span>' +
      '<div class="assigned">' + esc(d.medium.assignedLabel) + '</div>' +
      '<div class="why">' + esc(d.medium.reason) +
      (d.medium.contested ? ' Ranked across mediums; the score picked this one.' : '') +
      '</div></div>';

    if (d.notice) html += '<div class="notice">' + esc(d.notice) + '</div>';
    if (d.upgradeHint) html += '<div class="notice">' + esc(d.upgradeHint) + '</div>';

    const age = d.as_of ? ageHours(d.as_of) : NaN;
    if (d.as_of && age > STALE_H) {
      html += '<div class="notice">Data is ' + Math.round(age) + 'h old — the 6-hourly sync may be failing. ' +
        'Try again later or check /health.</div>';
    }

    if (d.results.length) {
      html += '<div class="board">' + d.results.map(row).join('') + '</div>';
    } else if (!d.notice) {
      html += '<div class="empty">Nothing departs on this route yet.</div>';
    }

    out.innerHTML = html;

    const bits = [];
    if (d.citation) bits.push(esc(d.citation));
    if (d.as_of) bits.push('Data as of ' + esc(d.as_of));
    bits.push('Scores are comparative, not absolute. "Model only" means the number was measured for the model, not in this harness.');
    attrib.innerHTML = bits.join('<br>') + '<br><a href="/settings">preferences</a>';
  }

  async function run(e) {
    if (e) e.preventDefault();
    const task = $('task').value.trim();
    if (!task) { $('task').focus(); return; }

    const needs = $('needs').value;
    const params = new URLSearchParams({
      task,
      size: $('size').value,
      tier: $('tier').value,
      quality: $('quality').value,
      exec: needs === 'exec' ? '1' : '0',
      files: needs === 'files' ? '1' : '0'
    });

    $('go').disabled = true;
    stamp.textContent = 'routing…';
    try {
      const res = await fetch('/api/recommend?' + params);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      render(await res.json());
      history.replaceState(null, '', '?' + params);
    } catch (err) {
      out.innerHTML = '<div class="notice">Could not reach the router: ' +
        esc(err.message) + '. Check that a sync has run.</div>';
      stamp.textContent = 'error';
    } finally {
      $('go').disabled = false;
    }
  }

  $('q').addEventListener('submit', run);

  // Restore state from the URL so results are shareable.
  const p = new URLSearchParams(location.search);
  if (p.get('task')) {
    $('task').value = p.get('task');
    if (p.get('size')) $('size').value = p.get('size');
    if (p.get('tier')) $('tier').value = p.get('tier');
    if (p.get('quality')) $('quality').value = p.get('quality');
    $('needs').value = p.get('exec') === '1' ? 'exec' : p.get('files') === '1' ? 'files' : 'none';
    run();
  } else {
    // No shared query? Fall back to the browser's saved defaults.
    const pr = prefs();
    if (pr.default_size) $('size').value = pr.default_size;
    if (pr.default_tier) $('tier').value = pr.default_tier;
    if (pr.default_quality) $('quality').value = pr.default_quality;
  }
})();
</script>
</body>
</html>`;

export const SETTINGS_HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ModelMap — preferences</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;500;600&family=Barlow:wght@400;500&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root {
    --ink:    #0E1C24;
    --panel:  #162A35;
    --rule:   #27424F;
    --bone:   #E9E4D6;
    --dim:    #7E97A3;
    --signal: #4EC08C;
    --amber:  #DFA23F;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--ink);
    color: var(--bone);
    font-family: 'Barlow', system-ui, sans-serif;
    font-size: 16px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 40rem; margin: 0 auto; padding: clamp(0.75rem, 2vw, 1.25rem); }
  header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
    padding-bottom: 0.6rem;
    border-bottom: 2px solid var(--rule);
  }
  .mark {
    font-family: 'Barlow Condensed', sans-serif;
    font-weight: 600;
    font-size: 1.6rem;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    margin: 0;
  }
  .mark span { color: var(--signal); }
  .back {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 0.68rem;
    color: var(--dim);
    text-decoration: none;
    letter-spacing: 0.04em;
  }
  .back:hover { color: var(--bone); }
  .card {
    margin-top: 1.6rem;
    background: var(--panel);
    border: 1px solid var(--rule);
    padding: 1.2rem;
  }
  .eyebrow {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 0.66rem;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--dim);
    display: block;
    margin-bottom: 0.4rem;
  }
  .field { margin-top: 1.1rem; }
  .field:first-child { margin-top: 0; }
  select {
    width: 100%;
    background: var(--ink);
    border: 1px solid var(--rule);
    color: var(--bone);
    font-family: 'Barlow', sans-serif;
    font-size: 0.9rem;
    padding: 0.5rem;
    border-radius: 2px;
  }
  .check {
    display: flex;
    gap: 0.7rem;
    align-items: baseline;
  }
  input[type="checkbox"] {
    accent-color: var(--signal);
    width: 1.05rem;
    height: 1.05rem;
    flex: 0 0 auto;
  }
  .help { color: var(--dim); font-size: 0.85rem; margin-top: 0.35rem; }
  .actions {
    display: flex;
    align-items: center;
    gap: 1rem;
    margin-top: 1.3rem;
  }
  button.go {
    background: var(--signal);
    color: var(--ink);
    border: 0;
    font-family: 'Barlow Condensed', sans-serif;
    font-weight: 600;
    font-size: 1rem;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    padding: 0.6rem 1.3rem;
    border-radius: 2px;
    cursor: pointer;
  }
  button.go:hover { filter: brightness(1.1); }
  a.reset {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 0.7rem;
    color: var(--dim);
  }
  footer {
    margin-top: 1.6rem;
    font-family: 'IBM Plex Mono', monospace;
    font-size: 0.64rem;
    color: var(--dim);
    line-height: 1.7;
  }
  .saved {
    margin-top: 1rem;
    padding: 0.6rem 0.8rem;
    border: 1px solid var(--signal);
    color: var(--signal);
    font-size: 0.85rem;
  }
</style>
</head>
<body>
<div class="wrap">

  <header>
    <h1 class="mark">Model<span>Map</span> · preferences</h1>
    <a class="back" href="/">← departures</a>
  </header>

  <form class="card" method="post" action="/settings">
    <div class="field check">
      <input type="checkbox" id="orpaid" name="openrouter_paid_credits">
      <div>
        <label for="orpaid" class="eyebrow">I have purchased credits on OpenRouter</label>
        <div class="help">Models offered free on OpenRouter pool their daily allowance.
          Once the platform's paid-credit threshold is met, that allowance rises ~20x and this
          board re-ranks accordingly — paying users are judged against the bigger bucket.</div>
      </div>
    </div>

    <div class="field">
      <span class="eyebrow">Default payload</span>
      <select id="size" name="default_size">
        <option value="small">Small · one question</option>
        <option value="medium">Medium · a few files</option>
        <option value="large">Large · whole project</option>
        <option value="agent">Agent · long run</option>
      </select>
    </div>

    <div class="field">
      <span class="eyebrow">Default cost tier</span>
      <select id="tier" name="default_tier">
        <option value="free">Free only</option>
        <option value="all">All models</option>
      </select>
    </div>

    <div class="field">
      <span class="eyebrow">Quality source</span>
      <select id="quality" name="default_quality">
        <option value="benchmark">Benchmark scores (AA / Design Arena)</option>
        <option value="share">Community use (OpenRouter token share)</option>
      </select>
      <div class="help">Benchmark ranks by measured indices; community use ranks by
        what the OpenRouter community actually spends tokens on over the trailing
        week — the same signal the platform's own rankings page shows.</div>
    </div>

    <div class="actions">
      <button class="go" type="submit">Save</button>
      <a class="reset" href="/settings?clear=1">reset all</a>
    </div>
  </form>

  <footer id="msg">Preferences live in a cookie on this browser. The board itself stays
  personalisable-without-accounts: no server-side user store is consulted on the request path.</footer>
</div>

<script>
(function () {
  const m = /(?:^|;\s*)mm_prefs=([^;]+)/.exec(document.cookie);
  const prefs = {};
  if (m) decodeURIComponent(m[1]).split('&').forEach(function (pair) {
    const i = pair.indexOf('=');
    if (i > 0) prefs[pair.slice(0, i)] = pair.slice(i + 1);
  });
  document.getElementById('orpaid').checked = prefs.openrouter_paid_credits === '1';
  if (prefs.default_size) document.getElementById('size').value = prefs.default_size;
  if (prefs.default_tier) document.getElementById('tier').value = prefs.default_tier;
  if (prefs.default_quality) document.getElementById('quality').value = prefs.default_quality;
  if (location.search === '?saved=1') {
    document.getElementById('msg').outerHTML =
      '<div class="saved">Saved — preferences apply to this browser.</div>';
  }
})();
</script>
</body>
</html>`;
