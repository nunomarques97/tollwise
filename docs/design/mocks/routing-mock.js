// Shared renderer for the three Routing view mocks and the Providers view mock.
// Each HTML file sets <body data-direction="drawer|inline|split">.
// Query string: ?theme=light|dark&view=routing|providers&state=live|loading|empty|error|refused|new
//               &open=1 (open the detail of the selected request)
//
// Data: window.ROUTING_DATA (routing-data.js) holds real /api/requests and /api/health responses from
// the demo. Two rows are illustrative and marked `illustrative: true` below (a refused request and a
// passthrough to a model with no catalog price), because the demo run produced neither. Candidates
// and exclusions are not recorded by Tollwise yet: the mock derives them from the real catalog entries
// below (catalog/models.yaml, verified 2026-09-19) and the demo's equivalence group, and they are
// therefore illustrative too.
(function () {
  const q = new URLSearchParams(location.search);
  const theme = q.get('theme') === 'dark' ? 'dark' : 'light';
  const view = q.get('view') === 'providers' ? 'providers' : 'routing';
  const state = q.get('state') || 'live';
  const open = q.get('open') === '1' || state === 'refused';
  document.documentElement.dataset.theme = theme;
  const dir = document.body.dataset.direction;
  const narrow = window.matchMedia('(max-width: 720px)').matches;
  const D = window.ROUTING_DATA;

  // ------------------------------------------------------------ catalog subset (real entries)
  const CAT = [
    ['anthropic', 'claude-opus-5', 'claude-opus-5', 5, 25, 'tjvs', 'https://platform.claude.com/docs/en/models/overview'],
    ['anthropic', 'claude-haiku-4-5-20251001', 'claude-haiku-4.5', 1, 5, 'tjvs', 'https://platform.claude.com/docs/en/models/overview'],
    ['openai', 'gpt-6-astra', 'gpt-6-astra', 10, 50, 'tjvs', 'https://developers.openai.com/api/docs/models/gpt-6-astra'],
    ['openai', 'gpt-5.6-luna', 'gpt-5.6-luna', 0.2, 1.2, 'tjvs', 'https://developers.openai.com/api/docs/models/gpt-5.6-luna'],
    ['deepseek', 'deepseek-v4-pro', 'deepseek-v4-pro-0813', 0.66, 1.98, 'tjs', 'https://api-docs.deepseek.com/quick_start/pricing/'],
    ['deepseek', 'deepseek-flash', 'deepseek-v4.1-flash', 0.15, 0.6, 'tjvs', 'https://api-docs.deepseek.com/quick_start/pricing/'],
    ['openrouter', 'anthropic/claude-opus-5', 'claude-opus-5', 5, 25, 'tjvs', 'https://openrouter.ai/anthropic/claude-opus-5'],
    ['openrouter', 'anthropic/claude-haiku-4.5', 'claude-haiku-4.5', 1, 5, 'tjvs', 'https://openrouter.ai/anthropic/claude-haiku-4.5'],
    ['openrouter', 'openai/gpt-6-astra', 'gpt-6-astra', 10, 50, 'tjvs', 'https://openrouter.ai/openai/gpt-6-astra'],
    ['openrouter', 'openai/gpt-5.6-luna', 'gpt-5.6-luna', 0.2, 1.2, 'tjvs', 'https://openrouter.ai/openai/gpt-5.6-luna'],
    ['openrouter', 'deepseek/deepseek-v4-pro-0813', 'deepseek-v4-pro-0813', 0.57816, 1.73448, 'tjs', 'https://openrouter.ai/deepseek/deepseek-v4-pro-0813'],
    ['openrouter', 'deepseek/deepseek-v4.1-flash', 'deepseek-v4.1-flash', 0.15, 0.6, 'tjvs', 'https://openrouter.ai/deepseek/deepseek-v4.1-flash'],
    ['ollama', 'llama3.1:8b', 'llama3.1-8b', 0, 0, 'tjs', 'https://ollama.com/library/llama3.1'],
  ].map(([provider, model, canonical, input, output, caps, source_url]) => ({
    provider, model, canonical, input, output, source_url, verified_on: '2026-09-19',
    caps: { tools: caps.includes('t'), json_mode: caps.includes('j'), vision: caps.includes('v'), streaming: caps.includes('s') },
  }));
  const GROUPS = [['gpt-5.6-luna', 'deepseek-v4.1-flash']];
  const NATIVE = { openai: 'openai', anthropic: 'anthropic' };

  function selection(e) {
    const r = e.route;
    const named = CAT.filter((c) => c.model === r.requestedModel);
    const req = named.find((c) => c.provider === NATIVE[r.format]) || named[0];
    if (!req) return { considered: [], candidates: [], excluded: [], requestedEntry: null };
    const group = GROUPS.find((g) => g.includes(req.canonical)) || [req.canonical];
    const considered = CAT.filter((c) => group.includes(c.canonical));
    const excluded = [];
    const candidates = [];
    for (const c of considered) {
      const miss = ['tools', 'json_mode', 'vision', 'streaming'].find((k) => e.needs[k] && !c.caps[k]);
      if (miss) excluded.push({ ...c, reason: 'missing_capability:' + miss });
      else candidates.push(c);
    }
    candidates.sort((a, b) => a.input + a.output - (b.input + b.output));
    return { considered, candidates, excluded, requestedEntry: req };
  }
  const entryFor = (provider, model) => CAT.find((c) => c.provider === provider && c.model === model) || null;

  // ------------------------------------------------------------ data
  let entries = D.entries.map((e) => ({ ...e }));
  const t0 = new Date(entries[0].timestamp).getTime();
  const refused = {
    illustrative: true,
    requestId: 'b7d0c1e2-5a44-4f0e-9d7c-2f3a8e61c0d9',
    timestamp: new Date(t0 - 1700).toISOString(),
    status: 'refused',
    route: { format: 'openai', requestedModel: 'deepseek-v4-pro', requestedProvider: 'deepseek', usedModel: null, usedProvider: null, policy: 'cheapest', decision: 'fail' },
    reason: 'refused: no configured provider could satisfy the requested capabilities',
    cost_usd: null, savings_usd: null, trace: [], latency_ms: 0, first_byte_ms: null, origin: null,
    baseline_usd: null, used_price_verified_on: null, baseline_price_verified_on: null,
    needs: { tools: false, json_mode: false, vision: true, streaming: false }, usage: null,
  };
  const unknown = {
    illustrative: true,
    requestId: '4c19e0a7-8e2b-4d71-a3f5-0b6e9d2c7a18',
    timestamp: new Date(t0 - 3900).toISOString(),
    status: 'complete',
    route: { format: 'openai', requestedModel: 'llama3.2:latest', requestedProvider: 'openai', usedModel: 'llama3.2:latest', usedProvider: 'ollama', policy: 'cheapest', decision: 'passthrough' },
    reason: 'no eligible candidate; passed through to the requested model',
    cost_usd: null, savings_usd: null,
    trace: [{ provider: 'ollama', model: 'llama3.2:latest', outcome: 'ok', status: 200, duration_ms: 214 }],
    latency_ms: 231, first_byte_ms: null, origin: 'estimated', baseline_usd: null,
    used_price_verified_on: null, baseline_price_verified_on: null,
    needs: { tools: false, json_mode: false, vision: false, streaming: false }, usage: { input: 42, output: 180 },
  };
  entries.splice(2, 0, refused);
  entries.splice(5, 0, unknown);
  refused.timestamp = entries[3].timestamp;
  unknown.timestamp = entries[6].timestamp;
  const PAGE = narrow ? 8 : 14;
  let shown = entries.slice(0, PAGE);
  if (state === 'new') shown = entries.slice(3, 3 + PAGE);
  // Selected: the fallback request (real) unless the refused state asks for the refused one.
  const selIndex = state === 'refused' ? shown.indexOf(refused) : shown.findIndex((e) => e.trace.length > 1);
  const selected = shown[Math.max(0, selIndex)];

  // ------------------------------------------------------------ formatting (DESIGN.md §6.9)
  function usd(s) {
    if (s === null || s === 'unknown') return 'Unknown';
    const v = Number(s);
    if (v === 0) return '$0.00';
    const a = Math.abs(v);
    const sign = v < 0 ? '-' : '';
    if (a >= 1) return sign + '$' + a.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const d = Math.min(6, Math.max(2, 2 - Math.floor(Math.log10(a))));
    return sign + '$' + a.toFixed(d);
  }
  const price = (x) => '$' + (x >= 1 ? x.toFixed(2) : x === 0 ? '0.00' : String(Number(x.toFixed(5))));
  const pad = (x) => String(x).padStart(2, '0');
  const clock = (iso) => { const t = new Date(iso); return pad(t.getHours()) + ':' + pad(t.getMinutes()) + ':' + pad(t.getSeconds()); };
  const ms = (x) => (x === null || x === undefined ? '—' : x < 1 ? '< 1 ms' : x.toLocaleString('en-US') + ' ms');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const FORMAT = { openai: 'OpenAI Chat Completions', anthropic: 'Anthropic Messages' };
  const STATUS = {
    complete: ['Complete', 'ok'], provider_error: ['Provider error', 'bad'], interrupted: ['Interrupted', 'warn'],
    client_aborted: ['Client closed', 'warn'], translation_failed: ['Translation failed', 'bad'], refused: ['Refused', 'bad'],
  };
  const OUTCOME = {
    ok: 'Served', server: 'Server error', rate_limit: 'Rate limited', overloaded: 'Overloaded', timeout: 'Timed out',
    connection: 'Connection failed', auth: 'Key refused', bad_request: 'Bad request', unknown: 'Failed', client_aborted: 'Client closed',
  };
  const NEEDS = { tools: 'Tools', json_mode: 'JSON mode', vision: 'Images', streaming: 'Streaming' };
  function reasonText(code) {
    if (code.startsWith('missing_capability:')) {
      const cap = code.split(':')[1];
      return { vision: 'Does not accept images; this request has one', tools: 'Does not support tool calls; this request uses them', json_mode: 'Has no JSON mode; this request asks for it', streaming: 'Cannot stream; this request streams' }[cap];
    }
    return {
      provider_down: 'Provider was down at the time', provider_not_configured: 'Provider not configured (no key set)',
      context_too_small: 'Context window too small for this request', max_output_too_small: 'Cannot produce the requested output length',
      provider_not_requested: 'The request named another provider',
    }[code] || code;
  }
  const statusCell = (e) => { const [t, k] = STATUS[e.status]; return `<span class="st st-${k}"><i aria-hidden="true"></i>${t}</span>`; };
  const attemptText = (a) => OUTCOME[a.outcome] + (a.status === null ? '' : ` · HTTP ${a.status}`);
  const savedCell = (e) => {
    if (e.savings_usd === null || e.savings_usd === 'unknown') return `<span class="unk">Unknown</span>`;
    const v = Number(e.savings_usd);
    return `<span class="${v > 0 ? 'pos' : ''}">${usd(e.savings_usd)}</span>`;
  };
  const origin = (e) => (e.origin ? `<span class="org">${e.origin}</span>` : '');
  const pips = (e) => e.trace.length === 0 ? '' :
    `<span class="pips" aria-hidden="true">${e.trace.map((a) => `<i class="${a.outcome === 'ok' ? 'ok' : 'fail'}"></i>`).join('')}</span>`;
  const routedCell = (e) => e.route.usedProvider === null
    ? `<span class="unk">Not routed</span>`
    : `<span class="prov">${e.route.usedProvider}${e.trace.length > 1 ? ` <span class="after">after ${e.trace.length - 1} failure${e.trace.length > 2 ? 's' : ''}</span>` : ''}</span><span class="mono sub">${esc(e.route.usedModel)}</span>`;

  // ------------------------------------------------------------ shell
  const tabs = document.getElementById('tabs');
  tabs.innerHTML = ['Overview', 'Routing', 'Savings', 'Providers'].map((t) =>
    `<a href="#" ${t.toLowerCase() === view ? 'aria-current="page"' : ''}>${t}</a>`).join('');
  const live = document.getElementById('live');
  live.innerHTML = state === 'error' ? '<i class="sq"></i>Not connected' : state === 'loading' ? '<i class="ring"></i>Connecting' : '<i></i>Live';
  document.getElementById('theme').textContent = theme === 'dark' ? 'Light' : 'Dark';
  const main = document.getElementById('main');
  const newest = shown[0] ? clock(shown[0].timestamp) : '';
  const asof = state === 'loading' ? 'Loading…' : state === 'empty' ? 'Waiting for the first request' : state === 'error' ? '' : `Last request ${newest}`;
  const barLeft = view === 'routing' ? 'Every recorded request, newest first' : 'Latest health checks and routed requests';
  main.innerHTML = `<div class="bar"><span class="scope">${barLeft}</span><span class="asof">${asof}</span></div>`;

  if (state === 'error') {
    main.insertAdjacentHTML('beforeend', `<div class="banner error" role="alert"><strong>Requests unavailable.</strong><span>Analytics is off (analytics.enabled is false in the configuration), so no metrics are recorded. Turn it on and restart Tollwise to see metrics.</span></div>`);
    return;
  }
  if (view === 'providers') return renderProviders();

  // ------------------------------------------------------------ routing: table
  function tableHtml(compact) {
    if (state === 'loading') {
      const sk = Array.from({ length: 8 }, () => `<tr>${Array.from({ length: compact ? 5 : 8 }, () => '<td><span class="skelline"></span></td>').join('')}</tr>`).join('');
      return `<table class="req"><thead>${head(compact)}</thead><tbody>${sk}</tbody></table>`;
    }
    const rows = shown.map((e, i) => rowHtml(e, i, compact)).join('');
    return `<table class="req${compact ? ' compact' : ''}"><caption class="vh">Recent requests, newest first</caption><thead>${head(compact)}</thead><tbody>${rows}</tbody></table>`;
  }
  function head(compact) {
    if (compact) return '<tr><th scope="col">Time</th><th scope="col">Routed to</th><th scope="col" class="r">Saved</th><th scope="col" class="r">Latency</th><th scope="col">Status</th></tr>';
    return '<tr><th scope="col">Time</th><th scope="col">Requested</th><th scope="col">Routed to</th><th scope="col">Policy</th><th scope="col" class="r">Cost</th><th scope="col" class="r">Saved</th><th scope="col" class="r">Latency</th><th scope="col">Status</th></tr>';
  }
  function rowHtml(e, i, compact) {
    const isSel = open && e === selected;
    const fresh = state === 'new' ? false : i < 1 && state === 'live' && dir !== 'split' ? false : false;
    const btn = `<button type="button" class="rowbtn" ${dir === 'inline' ? `aria-expanded="${isSel}"` : ''} tabindex="${i === 0 ? 0 : -1}">${dir === 'inline' ? '<svg class="chev" viewBox="0 0 10 10" aria-hidden="true"><path d="M3 2l4 3-4 3"/></svg>' : ''}${clock(e.timestamp)}</button>`;
    const cls = [isSel ? 'sel' : '', fresh ? 'fresh' : '', e.illustrative ? 'illus' : ''].join(' ');
    if (compact) {
      return `<tr class="${cls}"${isSel ? ' aria-current="true"' : ''}><td>${btn}</td><td>${pips(e)}${routedCell(e)}</td><td class="r">${savedCell(e)}${origin(e)}</td><td class="r">${ms(e.latency_ms)}</td><td>${statusCell(e)}</td></tr>`;
    }
    let tr = `<tr class="${cls}"${isSel ? ' aria-current="true"' : ''}><td>${btn}</td><td><span class="mono">${esc(e.route.requestedModel)}</span></td><td>${dir !== 'split' ? pips(e) : ''}${routedCell(e)}</td><td>${e.route.policy}</td><td class="r">${e.cost_usd === null ? '<span class="unk">Unknown</span>' : usd(e.cost_usd)}</td><td class="r">${savedCell(e)}${origin(e)}</td><td class="r">${ms(e.latency_ms)}</td><td>${statusCell(e)}</td></tr>`;
    if (dir === 'inline' && isSel) tr += `<tr class="expand"><td colspan="8">${detailHtml(e, 'inline')}</td></tr>`;
    return tr;
  }
  // Narrow list (390): one item per request, same content, three lines.
  function listHtml() {
    if (state === 'loading') return `<ul class="rlist">${Array.from({ length: 6 }, () => '<li><span class="skelline"></span><span class="skelline short"></span></li>').join('')}</ul>`;
    return `<ul class="rlist">${shown.map((e, i) => {
      const isSel = open && e === selected && dir === 'inline';
      return `<li class="${isSel ? 'sel' : ''}"><button type="button" class="rowbtn wide" ${dir === 'inline' ? `aria-expanded="${isSel}"` : ''} tabindex="${i === 0 ? 0 : -1}">
        <span class="l1"><span class="tm">${clock(e.timestamp)}</span>${statusCell(e)}</span>
        <span class="l2"><span class="mono">${esc(e.route.requestedModel)}</span><span class="arrow" aria-hidden="true">→</span>${e.route.usedProvider === null ? '<span class="unk">Not routed</span>' : `<span>${e.route.usedProvider}</span>`}${pips(e)}</span>
        <span class="l3"><span>Cost ${e.cost_usd === null ? '<span class="unk">Unknown</span>' : usd(e.cost_usd)}</span><span>Saved ${savedCell(e)} ${origin(e)}</span><span>${ms(e.latency_ms)}</span></span>
      </button>${isSel ? `<div class="expand-n">${detailHtml(e, 'inline')}</div>` : ''}</li>`;
    }).join('')}</ul>`;
  }
  function pager() {
    return `<div class="pager"><span class="count">Showing ${shown.length} of the newest requests</span><button type="button" class="linkbtn">Load 50 older requests</button></div>`;
  }
  function newBar() {
    return state === 'new' ? `<div class="newbar"><button type="button" class="pillbtn">3 new requests · Show</button></div>` : '';
  }
  function emptyHtml() {
    return `<p class="empty-note">No requests yet. Point your SDK's <code>base_url</code> at <code>http://127.0.0.1:8487/v1</code> and send a request; it appears here as soon as it completes.</p>`;
  }

  // ------------------------------------------------------------ routing: detail
  function detailHtml(e, where) {
    const sel = selection(e);
    const r = e.route;
    const tried = new Map(e.trace.map((a, i) => [a.provider + '|' + a.model, { ...a, n: i + 1 }]));
    const needs = Object.keys(NEEDS).filter((k) => e.needs[k]).map((k) => NEEDS[k]);
    const used = r.usedProvider ? entryFor(r.usedProvider, r.usedModel) : null;
    const base = sel.requestedEntry;
    let sentence;
    if (r.decision === 'fail') sentence = `Refused. No configured provider can serve <span class="mono">${esc(r.requestedModel)}</span> with the capabilities this request uses, and routing is set to fail rather than pass it through.`;
    else if (r.decision === 'passthrough') sentence = `Passed through to <span class="mono">${esc(r.requestedModel)}</span> on ${r.usedProvider}: the catalog has no entry for this model, so there was nothing to route between.`;
    else {
      const fails = e.trace.filter((a) => a.outcome !== 'ok');
      sentence = `Routed by the <b>${r.policy}</b> policy to ${r.usedProvider}` + (fails.length ? `, after ${fails.map((a) => `${a.provider} failed (${OUTCOME[a.outcome].toLowerCase()}${a.status ? `, HTTP ${a.status}` : ''})`).join(', ')}.` : '.');
    }

    const strip = where === 'drawer' ? routeStrip(e) : '';
    const ladder = where === 'split';
    const maxP = Math.max(...sel.considered.map((c) => c.input + c.output), 0.0001);
    const candRows = sel.candidates.map((c, i) => {
      const a = tried.get(c.provider + '|' + c.model);
      const res = a ? `<span class="${a.outcome === 'ok' ? 'res-ok' : 'res-bad'}">${attemptText(a)}</span>` : '<span class="unk">Not tried</span>';
      const bar = ladder ? `<span class="ptrack"><span class="pfill" style="width:${Math.max(2, ((c.input + c.output) / maxP) * 100)}%"></span></span>` : '';
      return `<li class="${a && a.outcome === 'ok' ? 'served' : ''}"><span class="rank">${i + 1}</span><span class="who"><span class="prov">${c.provider}</span> <span class="mono">${esc(c.model)}</span></span>${bar}<span class="pr">${price(c.input)} in · ${price(c.output)} out</span><span class="res">${res}</span></li>`;
    }).join('');
    const exclRows = sel.excluded.map((c) => `<li><span class="who"><span class="prov">${c.provider}</span> <span class="mono">${esc(c.model)}</span></span><span class="why">${reasonText(c.reason)}</span><code class="code">${c.reason}</code></li>`).join('');
    const attRows = e.trace.map((a, i) => `<li><span class="rank">${i + 1}</span><span class="who"><span class="prov">${a.provider}</span> <span class="mono">${esc(a.model)}</span></span><span class="${a.outcome === 'ok' ? 'res-ok' : 'res-bad'} res">${attemptText(a)}</span><span class="dur">${ms(a.duration_ms)}</span></li>`).join('');

    const priceRow = (label, en, when) => en
      ? `<div class="kv"><dt>${label}</dt><dd>${price(en.input)} in · ${price(en.output)} out per 1M tokens, verified <b>${when || en.verified_on}</b><a class="src mono" href="${en.source_url}">${en.source_url}</a></dd></div>`
      : `<div class="kv"><dt>${label}</dt><dd><span class="unk">No catalog price for this model</span></dd></div>`;
    const cost = r.decision === 'fail'
      ? `<p class="note">No provider was called, so nothing was charged and there is no saving to report.</p>`
      : `<dl class="cost">
          <div class="kv big"><dt>Cost</dt><dd>${e.cost_usd === null ? '<span class="unk">Unknown</span>' : usd(e.cost_usd)}</dd></div>
          <div class="kv big"><dt>Requested model would have cost</dt><dd>${e.baseline_usd === null ? '<span class="unk">Unknown</span>' : usd(e.baseline_usd)}</dd></div>
          <div class="kv big"><dt>Saved</dt><dd>${savedCell(e)}</dd></div>
          <div class="kv"><dt>Usage</dt><dd>${e.usage ? `${e.usage.input.toLocaleString('en-US')} in · ${e.usage.output.toLocaleString('en-US')} out tokens, ` : ''}${e.origin === 'reported' ? '<b>reported</b> by the provider' : '<b>estimated</b> by Tollwise (the provider reported no usage)'}</dd></div>
          ${priceRow('Price of the model used', used, e.used_price_verified_on)}
          ${priceRow('Price of the model requested', base, e.baseline_price_verified_on)}
        </dl>`;
    const head = `<div class="dhead">
        ${where === 'split' ? '' : ''}
        <h2 class="dtitle" id="dtitle">Request at ${clock(e.timestamp)}</h2>
        ${where === 'drawer' || where === 'page' ? `<button type="button" class="btn close" aria-label="Close request details">${where === 'page' ? 'Back' : 'Close'}</button>` : ''}
      </div>
      <p class="meta"><span class="mono rid">${e.requestId}</span>${FORMAT[r.format]} · ${statusCell(e)}</p>
      <p class="needs">${needs.length ? needs.map((x) => `<span class="chip">${x}</span>`).join('') : '<span class="chip">No special capabilities</span>'}</p>
      <p class="sentence">${sentence}</p>`;
    const cands = `<section><h3>Candidates <span class="h3n">${sel.candidates.length} eligible of ${sel.considered.length} considered · ranked by ${r.policy}</span></h3>${sel.candidates.length ? `<ol class="cands${ladder ? ' ladder' : ''}">${candRows}</ol>` : '<p class="note">No eligible candidate.</p>'}</section>`;
    const excl = `<section><h3>Excluded <span class="h3n">${sel.excluded.length}</span></h3>${sel.excluded.length ? `<ul class="excl">${exclRows}</ul>` : '<p class="note">No catalog entry was excluded.</p>'}</section>`;
    const atts = `<section><h3>Attempts <span class="h3n">${e.trace.length}</span></h3>${e.trace.length ? `<ol class="att">${attRows}</ol><p class="note">Total ${ms(e.latency_ms)}${e.first_byte_ms !== null ? `, first byte after ${ms(e.first_byte_ms)}` : ''}.</p>` : '<p class="note">No provider was called.</p>'}</section>`;
    const costS = `<section><h3>Cost and price source</h3>${cost}</section>`;
    const illus = e.illustrative ? '<p class="illus-note">Illustrative row: the demo run produced no request like this.</p>' : '';
    if (where === 'inline') return `<div class="dgrid">${head.replace(/<button[^>]*>.*?<\/button>/, '')}${illus}<div class="cols3"><div>${cands}${excl}</div><div>${atts}</div><div>${costS}</div></div></div>`;
    return `${head}${illus}${strip}${costS}${cands}${excl}${atts}`;
  }
  function routeStrip(e) {
    const steps = [`<li class="rq"><span class="k">Requested</span><span class="mono">${esc(e.route.requestedModel)}</span></li>`];
    e.trace.forEach((a, i) => steps.push(`<li class="${a.outcome === 'ok' ? 'ok' : 'fail'}"><span class="k">${i + 1}. ${a.provider}</span><span>${attemptText(a)}</span></li>`));
    if (!e.trace.length) steps.push(`<li class="fail"><span class="k">No provider</span><span>Refused</span></li>`);
    return `<ol class="strip" aria-label="Route">${steps.join('<li class="sep" aria-hidden="true">→</li>')}</ol>`;
  }

  // ------------------------------------------------------------ routing: layout per direction
  const empty = state === 'empty';
  if (dir === 'split' && !narrow) {
    main.insertAdjacentHTML('beforeend', `<div class="split">
      <section class="card primary tight"><div class="phead"><h1 class="lbl">Recent requests</h1></div>${empty ? emptyHtml() : newBar() + tableHtml(true) + (state === 'loading' ? '' : pager())}</section>
      <aside class="card pane" aria-labelledby="dtitle">${empty || state === 'loading' ? '<p class="note">Select a request to see how it was routed.</p>' : detailHtml(selected, 'split')}</aside></div>`);
    return;
  }
  if (dir === 'split' && narrow && open) {
    main.insertAdjacentHTML('beforeend', `<section class="card primary page">${detailHtml(selected, 'page')}</section>`);
    return;
  }
  main.insertAdjacentHTML('beforeend', `<section class="card primary tight"><div class="phead"><h1 class="lbl">Recent requests</h1></div>${empty ? emptyHtml() : newBar() + (narrow ? listHtml() : tableHtml(false)) + (state === 'loading' ? '' : pager())}</section>`);
  if (dir === 'drawer' && open && !empty) {
    document.body.insertAdjacentHTML('beforeend', `<div class="scrim" aria-hidden="true"></div><div class="drawer" role="dialog" aria-modal="true" aria-labelledby="dtitle">${detailHtml(selected, 'drawer')}</div>`);
    document.body.classList.add('locked');
  }

  // ------------------------------------------------------------ providers view
  function renderProviders() {
    const H = D.health.providers;
    const ids = Object.keys(H);
    // Illustrative: the demo's providers are all up; one is shown down and one not yet checked.
    const rows = ids.map((id) => ({ id, ...H[id] }));
    if (q.get('mix') !== '0') {
      rows[2] = { ...rows[2], state: 'down', last_error_kind: 'rate_limit', illustrative: true };
      rows[4] = { ...rows[4], state: 'unknown', p50_ms: null, p95_ms: null, last_checked: null, samples: 0, last_error_kind: null, illustrative: true };
    }
    const max = Math.max(...rows.map((r) => r.p95_ms || 0), 1);
    const step = max <= 5 ? 1 : max <= 20 ? 5 : max <= 100 ? 25 : 100;
    const top = Math.ceil(max / step) * step;
    const ticks = []; for (let v = 0; v <= top; v += step) ticks.push(v);
    const ST = { up: ['Up', 'up'], down: ['Down', 'down'], unknown: ['Not checked yet', 'unk'] };
    const ERR = { rate_limit: 'rate limited', server: 'server error', timeout: 'timed out', connection: 'connection failed', auth: 'key refused', overloaded: 'overloaded', bad_request: 'bad request', unknown: 'failed' };
    const since = (iso) => iso ? clock(iso) : '—';
    const loading = state === 'loading';
    const list = rows.map((r) => {
      const [label, k] = ST[r.state];
      const plot = r.p50_ms === null
        ? `<span class="lplot none"><span class="unk">No samples yet</span></span>`
        : `<span class="lplot" aria-hidden="true"><span class="lr" style="left:${(r.p50_ms / top) * 100}%;width:${Math.max(0, ((r.p95_ms - r.p50_ms) / top) * 100)}%"></span><span class="l50" style="left:${(r.p50_ms / top) * 100}%"></span><span class="l95" style="left:${(r.p95_ms / top) * 100}%"></span></span>`;
      return `<li class="prow${r.illustrative ? ' illus' : ''}">
        <span class="pname">${r.id}</span>
        <span class="hstate hs-${k}"><i aria-hidden="true"></i>${label}${r.state === 'down' && r.last_error_kind ? `<span class="hwhy"> · ${ERR[r.last_error_kind]}</span>` : ''}</span>
        <span class="p50"><span class="k">p50</span> ${loading ? '<span class="skelline"></span>' : ms(r.p50_ms)}</span>
        <span class="p95"><span class="k">p95</span> ${loading ? '<span class="skelline"></span>' : ms(r.p95_ms)}</span>
        ${loading ? '<span class="lplot"><span class="skelline"></span></span>' : plot}
        <span class="pmeta">${r.last_checked === null ? 'First check pending' : `${r.samples.toLocaleString('en-US')} samples · checked ${since(r.last_checked)}`}</span>
      </li>`;
    }).join('');
    const axis = `<div class="paxis" aria-hidden="true"><span></span><span class="ticks">${ticks.map((v) => `<span style="left:${(v / top) * 100}%">${v} ms</span>`).join('')}</span></div>`;
    const down = rows.filter((r) => r.state === 'down').length;
    main.insertAdjacentHTML('beforeend', `<section class="card primary">
      <div class="phead"><h1 class="lbl">Providers</h1><span class="h1n">${rows.length} configured · ${down ? `<b class="dangerv">${down} down</b>` : 'all up'}</span></div>
      <p class="lead-s">Latency is measured on the last 100 samples per provider: health checks and the requests routed to it.</p>
      <div class="plegend" aria-hidden="true"><span><i class="lg50"></i>p50 (median)</span><span><i class="lgr"></i>p50 to p95</span><span><i class="lg95"></i>p95</span>${narrow ? `<span>Scale 0 to ${top} ms</span>` : ''}</div>
      <ul class="plist">${list}</ul>${narrow ? '' : axis}
      <details class="data"><summary>Show the data as a table</summary></details>
      <p class="illus-note">Illustrative: deepseek is shown down and ollama not yet checked; in the demo every provider is up.</p>
    </section>`);
  }
})();
