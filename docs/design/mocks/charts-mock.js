// Shared renderer for the three chart mocks. Each HTML file sets <body data-treatment="stack|split|ledger">.
// Query string: ?theme=light|dark&state=live|loading|empty|unknown|error
// All numbers come from window.CHART_DATA (charts-data.js, real API responses) except the "unknown"
// state, which marks two real buckets as wholly unknown and one as partly unknown to show that
// state. Those numbers are illustrative, not measured.
(function () {
  const q = new URLSearchParams(location.search);
  const theme = q.get('theme') === 'dark' ? 'dark' : 'light';
  const state = q.get('state') || 'live';
  document.documentElement.dataset.theme = theme;
  const treatment = document.body.dataset.treatment;
  const D = window.CHART_DATA;
  const narrow = window.matchMedia('(max-width: 720px)').matches;
  const SVGNS = 'http://www.w3.org/2000/svg';

  // ------------------------------------------------------------ formatting (DESIGN.md §6.9)
  const n = (x) => x.toLocaleString('en-US');
  function usd(s) {
    if (s === 'unknown') return 'Unknown';
    const v = Number(s);
    if (v === 0) return '$0.00';
    const a = Math.abs(v);
    const sign = v < 0 ? '-' : '';
    if (a >= 1) return sign + '$' + a.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const d = Math.min(6, Math.max(2, 2 - Math.floor(Math.log10(a))));
    return sign + '$' + a.toFixed(d);
  }
  const hm = (iso) => { const t = new Date(iso); return String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0'); };
  const plural = (k, one, many) => `${n(k)} ${k === 1 ? one : many}`;

  // ------------------------------------------------------------ scales
  function niceStep(max, count) {
    const raw = max / count;
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
  }
  function ticks(max, count) {
    if (!(max > 0)) return { top: 1, list: [0], step: 1 };
    const step = niceStep(max, count);
    const top = Math.ceil(max / step) * step;
    const list = [];
    for (let v = 0; v <= top + step / 2; v += step) list.push(v);
    return { top, list, step };
  }
  function tickUsd(v, step) {
    if (v === 0) return '$0';
    const d = Math.min(6, Math.max(2, -Math.floor(Math.log10(step))));
    return '$' + v.toFixed(d);
  }

  function el(name, attrs, parent) {
    const e = document.createElementNS(SVGNS, name);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function text(parent, x, y, s, anchor, cls) {
    const t = el('text', { x, y, 'text-anchor': anchor || 'start' }, parent);
    if (cls) t.setAttribute('class', cls);
    t.textContent = s;
    return t;
  }
  function hatchDefs(svg, id) {
    const defs = el('defs', {}, svg);
    const p = el('pattern', { id, width: 5, height: 5, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, defs);
    el('line', { x1: 0, y1: 0, x2: 0, y2: 5, class: 'hatch-line' }, p);
  }
  function swatchHatch() {
    const s = document.createElementNS(SVGNS, 'svg');
    s.setAttribute('class', 'swatch'); s.setAttribute('viewBox', '0 0 10 10'); s.setAttribute('aria-hidden', 'true');
    hatchDefs(s, 'hatch-legend');
    el('rect', { x: 0.5, y: 0.5, width: 9, height: 9, class: 'unknown-band' }, s);
    return s;
  }

  // ------------------------------------------------------------ data for this state
  const series = JSON.parse(JSON.stringify(narrow ? D.ts5m : D.ts1m));
  const byProvider = JSON.parse(JSON.stringify(D.byProvider));
  const byModel = JSON.parse(JSON.stringify(D.byModel));
  const sum = JSON.parse(JSON.stringify(D.summary));
  const bucketWord = series.bucket === '1m' ? 'minute' : series.bucket === '5m' ? '5 minutes' : series.bucket === '1h' ? 'hour' : 'day';
  if (state === 'unknown') {
    // Illustrative only: two buckets whose every request asked for a model with no catalog price.
    const withReq = series.buckets.map((b, i) => (b.requests > 0 ? i : -1)).filter((i) => i >= 0);
    for (const i of [withReq[2], withReq[3]]) {
      const b = series.buckets[i];
      b.unknown_savings_requests = b.requests; b.savings_usd = 'unknown';
    }
    const b5 = series.buckets[withReq[withReq.length - 1]]; b5.unknown_savings_requests = 38;
    sum.unknown_savings_requests = series.buckets.reduce((a, b) => a + b.unknown_savings_requests, 0);
  }
  if (state === 'empty') {
    for (const b of series.buckets) Object.assign(b, { requests: 0, errors: 0, spend_usd: '0.000000', savings_usd: '0.000000', unpriced_requests: 0, unknown_savings_requests: 0 });
  }
  const last = series.buckets[series.buckets.length - 1];
  const lastWithReq = [...series.buckets].reverse().find((b) => b.requests > 0);

  // ------------------------------------------------------------ shell
  const main = document.getElementById('main');
  const tabs = document.getElementById('tabs');
  tabs.innerHTML = '<a href="#">Overview</a><a href="#">Routing</a><a href="#" aria-current="page">Savings</a><a href="#">Providers</a>';
  document.getElementById('theme').textContent = theme === 'dark' ? 'Light' : 'Dark';
  const liveText = state === 'loading' ? 'Connecting' : state === 'error' ? 'Not connected' : 'Live';
  document.getElementById('live').innerHTML = `<i aria-hidden="true"></i>${liveText}`;
  if (state === 'loading') document.querySelector('#live i').style.cssText = 'background:transparent;border:2px solid var(--muted)';
  if (state === 'error') document.querySelector('#live i').style.cssText = 'background:var(--warning);border-radius:1px';
  const asof = state === 'loading' ? 'Loading…' : state === 'empty' ? 'Waiting for the first request' : state === 'error' ? '' : `Last request ${hm(D.capturedAt)}:59`;
  main.insertAdjacentHTML('beforeend', `<div class="bar"><div class="seg" role="group" aria-label="Time range"><button aria-pressed="true">1 hour</button><button aria-pressed="false">24 hours</button><button aria-pressed="false">7 days</button><button aria-pressed="false">30 days</button></div><span class="asof">${asof}</span></div>`);
  if (state === 'error') {
    main.insertAdjacentHTML('beforeend', '<div class="banner error" role="alert"><strong>Metrics unavailable.</strong><span>Analytics is off (analytics.enabled is false in the configuration), so no metrics are recorded. Turn it on and restart Tollwise to see metrics.</span></div>');
  }

  const primary = document.createElement('section');
  primary.className = 'card primary';
  primary.setAttribute('aria-labelledby', 'h1');
  main.appendChild(primary);
  primary.insertAdjacentHTML('beforeend', '<h1 class="lbl" id="h1">Savings over the last hour</h1>');

  function chips(target) {
    const left = sum.unknown_savings_requests;
    target.insertAdjacentHTML('beforeend', `<div class="basis">
      <span class="chip">Usage <b>${n(sum.origin.reported)} reported</b> · ${n(sum.origin.estimated)} estimated</span>
      ${left === 0 ? '<span class="chip">Savings known for <b>all requests</b></span>' : `<span class="chip warn"><b>${plural(left, 'request', 'requests')}</b> left out: savings unknown</span>`}
      <span class="chip">Prices verified <b>${sum.prices_verified_on.newest}</b></span></div>`);
  }

  function headline(target) {
    target.insertAdjacentHTML('beforeend', `<div class="headline">
      <div><span class="k">Saved</span><span class="v pos">${usd(sum.savings_usd)}</span></div>
      <div><span class="k">Spend</span><span class="v">${usd(sum.spend_usd)}</span></div>
      <div><span class="k">Baseline</span><span class="v">${usd(sum.baseline_usd)}</span></div></div>`);
  }

  function dataTable(target, caption) {
    const rows = series.buckets.filter((b) => b.requests > 0 || state !== 'live');
    const body = series.buckets.map((b) => {
      const inProgress = b === last ? ' <span class="nw">(in progress)</span>' : '';
      const sv = b.requests === 0 ? '<td class="unk">—</td>' : b.savings_usd === 'unknown' ? '<td class="unk">Unknown</td>' : `<td>${usd(b.savings_usd)}</td>`;
      return `<tr><td>${hm(b.bucket_start)}${inProgress}</td><td>${n(b.requests)}</td><td>${b.requests === 0 ? '—' : usd(b.spend_usd)}</td>${sv}<td>${b.unknown_savings_requests ? n(b.unknown_savings_requests) : '0'}</td></tr>`;
    }).join('');
    void rows;
    target.insertAdjacentHTML('beforeend', `<details class="data"><summary>Show the data as a table</summary><div class="scroll" role="region" aria-label="${caption}, as a table" tabindex="0"><table><caption class="sr" hidden>${caption}</caption><thead><tr><th scope="col">Start</th><th scope="col">Requests</th><th scope="col">Spend</th><th scope="col">Saved</th><th scope="col">Left out</th></tr></thead><tbody>${body}</tbody></table></div></details>`);
  }

  function svgFor(target, height, label) {
    const w = Math.max(280, Math.floor(target.clientWidth));
    const svg = el('svg', { class: 'chart', viewBox: `0 0 ${w} ${height}`, width: w, height, role: 'img', 'aria-label': label });
    target.appendChild(svg);
    return { svg, w };
  }

  // x positions shared by the treatments
  function xLayout(w, left, right) {
    const nB = series.buckets.length;
    const plotW = w - left - right;
    const slot = plotW / nB;
    const gapPx = slot >= 8 ? 2 : slot >= 4 ? 1 : 0;
    return { nB, slot, bw: Math.max(1, slot - gapPx), x: (i) => left + i * slot + gapPx / 2 };
  }
  function xTicks(svg, lay, y, left) {
    const every = series.bucket === '1m' ? 10 : 3; // 1m: every 10 minutes; 5m: every 15 minutes
    series.buckets.forEach((b, i) => {
      const m = new Date(b.bucket_start).getMinutes();
      if ((series.bucket === '1m' && m % 10 === 0) || (series.bucket === '5m' && m % 15 === 0)) {
        text(svg, lay.x(i) + lay.bw / 2, y, hm(b.bucket_start), 'middle');
      }
    });
    void every; void left;
  }
  function leftOutStrip(svg, lay, y) {
    series.buckets.forEach((b, i) => {
      if (b.unknown_savings_requests > 0 && b.savings_usd !== 'unknown') el('rect', { x: lay.x(i), y, width: Math.max(lay.bw, 3), height: 4, class: 'left' }, svg);
    });
  }

  function legend(target, items) {
    const div = document.createElement('div');
    div.className = 'legend';
    for (const [kind, label] of items) {
      const s = document.createElement('span');
      if (kind === 'hatch') s.appendChild(swatchHatch()); else s.insertAdjacentHTML('beforeend', `<i class="sw ${kind}" aria-hidden="true"></i>`);
      s.insertAdjacentHTML('beforeend', label);
      div.appendChild(s);
    }
    target.appendChild(div);
  }

  function readout(target) {
    const b = lastWithReq;
    if (!b) return;
    const inProg = b === last ? ' (in progress)' : '';
    target.insertAdjacentHTML('beforeend', `<p class="readout" aria-hidden="true"><b>${hm(b.bucket_start)}</b>${inProg} · Saved <b>${usd(b.savings_usd)}</b> · Spend <b>${usd(b.spend_usd)}</b> · ${n(b.requests)} requests</p>`);
  }

  const totalSaved = usd(sum.savings_usd);
  const maxSave = Math.max(...series.buckets.map((b) => (b.savings_usd === 'unknown' ? 0 : Number(b.savings_usd))));
  const maxSpend = Math.max(...series.buckets.map((b) => (b.spend_usd === 'unknown' ? 0 : Number(b.spend_usd))));
  const maxBase = Math.max(...series.buckets.map((b) => Number(b.spend_usd) + (b.savings_usd === 'unknown' ? 0 : Number(b.savings_usd))));
  const leftOut = sum.unknown_savings_requests;
  const ariaSave = `Savings per ${bucketWord} over the last hour, ${series.buckets.length} bars. ${totalSaved} saved in total; highest ${usd(String(maxSave))} in one ${bucketWord}.${leftOut ? ` ${plural(leftOut, 'request', 'requests')} left out: savings unknown.` : ''}`;

  // ------------------------------------------------------------ loading / empty
  function skeletonChart(target, h) {
    const { svg, w } = svgFor(target, h, 'Loading chart');
    for (let i = 0; i < 4; i++) el('line', { x1: 64, x2: w, y1: 8 + i * ((h - 32) / 3), y2: 8 + i * ((h - 32) / 3), class: 'grid' }, svg);
    el('rect', { x: 64, y: h - 20, width: Math.min(w - 64, 360), height: 12, rx: 6, class: 'skel' }, svg);
  }

  // ------------------------------------------------------------ treatment A: Stack
  function stack() {
    if (state === 'loading') { primary.setAttribute('aria-busy', 'true'); skeletonChart(primary, narrow ? 200 : 280); return; }
    headline(primary);
    readout(primary);
    const H = narrow ? 200 : 280, L = 64, R = 8, T = 8, B = 28;
    const { svg, w } = svgFor(primary, H, `Spend and savings per ${bucketWord}, stacked to the baseline. ${ariaSave}`);
    hatchDefs(svg, 'hatch');
    const t = ticks(maxBase, narrow ? 3 : 4);
    const ph = H - T - B;
    const y = (v) => T + ph - (v / t.top) * ph;
    for (const v of t.list) { el('line', { x1: L, x2: w - R, y1: y(v), y2: y(v), class: v === 0 ? 'zero' : 'grid' }, svg); text(svg, L - 8, y(v) + 4, tickUsd(v, t.step), 'end'); }
    const lay = xLayout(w, L, R);
    series.buckets.forEach((b, i) => {
      if (b.requests === 0) return;
      const sp = Number(b.spend_usd);
      const x = lay.x(i);
      if (b.savings_usd === 'unknown') { el('rect', { x, y: T, width: lay.bw, height: ph, class: 'unknown-band' }, svg); }
      el('rect', { x, y: y(sp), width: lay.bw, height: y(0) - y(sp), class: 'spend' }, svg);
      if (b.savings_usd !== 'unknown') {
        const s = Number(b.savings_usd);
        el('rect', { x, y: y(sp + s), width: lay.bw, height: Math.max(1, y(sp) - y(sp + s)), class: 'save' }, svg);
      }
    });
    leftOutStrip(svg, lay, H - B + 2);
    xTicks(svg, lay, H - 6, L);
    if (state === 'empty') emptyNote(primary);
    legend(primary, [['spend', 'Spend'], ['save', 'Saved (spend + saved = baseline)'], ['left', 'Some requests left out'], ['hatch', 'Savings unknown']]);
    chips(primary);
    dataTable(primary, `Spend and savings per ${bucketWord}`);
  }

  // ------------------------------------------------------------ treatment B: Split
  function split() {
    if (state === 'loading') {
      primary.setAttribute('aria-busy', 'true'); primary.setAttribute('aria-label', 'Loading savings chart');
      primary.insertAdjacentHTML('beforeend', `<div class="chart-title">Saved per ${bucketWord}</div>`);
      skeletonChart(primary, narrow ? 160 : 200);
      primary.insertAdjacentHTML('beforeend', `<div class="chart-title">Spend per ${bucketWord}</div>`);
      skeletonChart(primary, narrow ? 96 : 112);
      return;
    }
    if (state === 'error') { primary.remove(); return; }
    if (state === 'empty') { emptyNote(primary); return; }
    const L = narrow ? 56 : 72, R = 8;
    // Savings chart
    primary.insertAdjacentHTML('beforeend', `<div class="chart-title"><span>Saved per ${bucketWord}</span><span class="u">${totalSaved} in total</span></div>`);
    readout(primary);
    const H1 = narrow ? 160 : 200, T = 8, B1 = 10;
    const a = svgFor(primary, H1, ariaSave);
    hatchDefs(a.svg, 'hatch');
    const t1 = ticks(maxSave, 3);
    const ph1 = H1 - T - B1;
    const y1 = (v) => T + ph1 - (v / t1.top) * ph1;
    for (const v of t1.list) { el('line', { x1: L, x2: a.w - R, y1: y1(v), y2: y1(v), class: v === 0 ? 'zero' : 'grid' }, a.svg); text(a.svg, L - 8, y1(v) + 4, tickUsd(v, t1.step), 'end'); }
    const lay = xLayout(a.w, L, R);
    series.buckets.forEach((b, i) => {
      if (b.requests === 0) return;
      const x = lay.x(i);
      if (b.savings_usd === 'unknown') { el('rect', { x: x + 0.5, y: T + 0.5, width: lay.bw - 1, height: ph1 - 1, class: 'unknown-band' }, a.svg); return; }
      const s = Number(b.savings_usd);
      if (s === 0) { el('rect', { x, y: y1(0) - 2, width: lay.bw, height: 2, class: 'stub' }, a.svg); return; }
      el('rect', { x, y: y1(s), width: lay.bw, height: y1(0) - y1(s), class: 'save' }, a.svg);
    });
    leftOutStrip(a.svg, lay, H1 - B1 + 3);
    // Spend chart
    primary.insertAdjacentHTML('beforeend', `<div class="chart-title"><span>Spend per ${bucketWord}</span><span class="u">${usd(sum.spend_usd)} in total</span></div>`);
    const H2 = narrow ? 104 : 124, B2 = 26;
    const c = svgFor(primary, H2, `Spend per ${bucketWord} over the last hour. ${usd(sum.spend_usd)} in total; highest ${usd(String(maxSpend))} in one ${bucketWord}.`);
    const t2 = ticks(maxSpend, 2);
    const ph2 = H2 - T - B2;
    const y2 = (v) => T + ph2 - (v / t2.top) * ph2;
    for (const v of t2.list) { el('line', { x1: L, x2: c.w - R, y1: y2(v), y2: y2(v), class: v === 0 ? 'zero' : 'grid' }, c.svg); text(c.svg, L - 8, y2(v) + 4, tickUsd(v, t2.step), 'end'); }
    // The line breaks over buckets with no requests or unknown spend: a gap, never a drop to $0.
    let d = '', open = false;
    series.buckets.forEach((b, i) => {
      if (b.requests === 0 || b.spend_usd === 'unknown') { open = false; return; }
      const x = lay.x(i) + lay.bw / 2, yy = y2(Number(b.spend_usd));
      d += `${open ? 'L' : 'M'}${x.toFixed(1)} ${yy.toFixed(1)} `;
      open = true;
    });
    el('path', { d: d.trim(), class: 'spendline' }, c.svg);
    series.buckets.forEach((b, i) => { if (b.requests > 0 && b.spend_usd !== 'unknown' && series.buckets.filter((x) => x.requests > 0).length === 1) el('circle', { cx: lay.x(i) + lay.bw / 2, cy: y2(Number(b.spend_usd)), r: 3, class: 'spend' }, c.svg); });
    xTicks(c.svg, lay, H2 - 6, L);
    if (state === 'empty') emptyNote(primary);
    legend(primary, [['save', 'Saved'], ['line', 'Spend'], ['left', 'Some requests left out'], ['hatch', 'Savings unknown (not $0)']]);
    chips(primary);
    dataTable(primary, `Savings and spend per ${bucketWord}`);
  }

  // ------------------------------------------------------------ treatment C: Ledger
  function ledger() {
    if (state === 'loading') { primary.setAttribute('aria-busy', 'true'); skeletonChart(primary, narrow ? 200 : 260); return; }
    headline(primary);
    const H = narrow ? 200 : 260, L = narrow ? 52 : 64, R = narrow ? 8 : 150, T = 12, B = 28;
    const { svg, w } = svgFor(primary, H, `Running totals over the last hour: spend ${usd(sum.spend_usd)} against a baseline of ${usd(sum.baseline_usd)}; the gap is the ${totalSaved} saved.`);
    let cs = 0, cb = 0;
    const pts = series.buckets.map((b) => { cs += Number(b.spend_usd === 'unknown' ? 0 : b.spend_usd); cb += Number(b.spend_usd === 'unknown' ? 0 : b.spend_usd) + (b.savings_usd === 'unknown' ? 0 : Number(b.savings_usd)); return [cs, cb, b.requests]; });
    const t = ticks(cb, narrow ? 3 : 4);
    const ph = H - T - B;
    const y = (v) => T + ph - (v / t.top) * ph;
    for (const v of t.list) { el('line', { x1: L, x2: w - R, y1: y(v), y2: y(v), class: v === 0 ? 'zero' : 'grid' }, svg); text(svg, L - 8, y(v) + 4, tickUsd(v, t.step), 'end'); }
    const lay = xLayout(w, L, R);
    const xs = (i) => lay.x(i) + lay.bw;
    const first = pts.findIndex((p) => p[2] > 0);
    let top = '', bot = '';
    if (first >= 0) {
      for (let i = first; i < pts.length; i++) { top += `${i === first ? 'M' : 'L'}${xs(i).toFixed(1)} ${y(pts[i][1]).toFixed(1)}`; }
      for (let i = pts.length - 1; i >= first; i--) { bot += `L${xs(i).toFixed(1)} ${y(pts[i][0]).toFixed(1)}`; }
      el('path', { d: top + bot + 'Z', class: 'gap' }, svg);
      el('path', { d: top, class: 'baseline' }, svg);
      el('path', { d: 'M' + bot.slice(1), class: 'spendline' }, svg);
      if (!narrow) {
        const ex = w - R + 8;
        text(svg, ex, y(pts[pts.length - 1][1]) - 8, `Baseline ${usd(sum.baseline_usd)}`, 'start', 'end txt');
        text(svg, ex, y(pts[pts.length - 1][0]) + 12, `Spend ${usd(sum.spend_usd)}`, 'start', 'end');
        text(svg, ex, y(pts[pts.length - 1][0]) + 30, `Saved ${totalSaved}`, 'start', 'end pos');
      }
    }
    leftOutStrip(svg, lay, H - B + 2);
    xTicks(svg, lay, H - 6, L);
    if (state === 'empty') emptyNote(primary);
    legend(primary, [['dash', 'Baseline, running total'], ['line', 'Spend, running total'], ['save', 'Saved (the gap)'], ['left', 'Some requests left out']]);
    chips(primary);
    dataTable(primary, 'Spend and savings per minute');
  }

  function emptyNote(target) {
    target.insertAdjacentHTML('beforeend', '<p class="empty-note">No requests in this range yet. Point your SDK\'s <code>base_url</code> at <code>http://127.0.0.1:8484/v1</code> and send a request; it appears here as soon as it completes.</p>');
  }

  // ------------------------------------------------------------ breakdown
  function rowsHtml(groups, mono, unrouted) {
    const known = groups.filter((g) => g.spend_usd !== 'unknown');
    const total = known.reduce((a, g) => a + Number(g.spend_usd), 0);
    const max = Math.max(...known.map((g) => Number(g.spend_usd)), 0);
    return groups.map((g) => {
      const unk = g.spend_usd === 'unknown';
      const v = unk ? 0 : Number(g.spend_usd);
      const note = unk ? `${plural(g.unpriced_requests, 'request', 'requests')}, no catalog price` : g.unpriced_requests ? `Lower bound: ${plural(g.unpriced_requests, 'request', 'requests')} unpriced` : '';
      const pct = unk || total === 0 ? '—' : `${Math.round((v / total) * 100)}%`;
      const bar = unk ? '<span class="track unknown" aria-hidden="true"></span>' : `<span class="track" aria-hidden="true"><span class="fill${v === 0 ? ' zero' : ''}" data-w="${max ? (v / max) * 100 : 0}"></span></span>`;
      return `<li class="row"><span class="name${mono ? ' mono' : ''}">${g.key}${note ? `<span class="note">${note}</span>` : ''}</span>${bar}<span class="val${unk ? ' unk' : ''}">${usd(g.spend_usd)}</span><span class="pct">${pct}</span></li>`;
    }).join('') + (unrouted ? '' : '');
  }
  function breakdownTable(groups, keyLabel, caption) {
    const body = groups.map((g) => `<tr><td>${g.key}</td><td>${n(g.requests)}</td><td class="${g.spend_usd === 'unknown' ? 'unk' : ''}">${usd(g.spend_usd)}</td><td>${n(g.unpriced_requests)}</td></tr>`).join('');
    return `<details class="data"><summary>Show the data as a table</summary><div class="scroll" role="region" aria-label="${caption}, as a table" tabindex="0"><table><thead><tr><th scope="col">${keyLabel}</th><th scope="col">Requests</th><th scope="col">Spend</th><th scope="col">Unpriced</th></tr></thead><tbody>${body}</tbody></table></div></details>`;
  }
  function barAria(groups, what) {
    const known = groups.filter((g) => g.spend_usd !== 'unknown');
    const unk = groups.length - known.length;
    return `Spend by ${what} over the last hour, ${groups.length} bars, highest first: ` + known.slice(0, 3).map((g) => `${g.key} ${usd(g.spend_usd)}`).join(', ') + (known.length > 3 ? `, and ${known.length - 3} more` : '') + (unk ? `; ${unk} with unknown spend` : '') + '.';
  }
  function barCard(parent, title, groups, mono, what, keyLabel) {
    const card = document.createElement('section');
    card.className = 'card';
    const id = 'h-' + what;
    card.setAttribute('aria-labelledby', id);
    if (state === 'loading') {
      card.innerHTML = `<h2 class="lbl" id="${id}">${title}</h2><div class="rows">${'<div class="skelline"></div>'.repeat(4)}</div>`;
      parent.appendChild(card); return;
    }
    if (state === 'empty') {
      card.innerHTML = `<h2 class="lbl" id="${id}">${title}</h2><p class="foot">No requests in this range yet.</p>`;
      parent.appendChild(card); return;
    }
    card.innerHTML = `<h2 class="lbl" id="${id}">${title}</h2><ul class="rows" role="img" aria-label="${barAria(groups, what)}">${rowsHtml(groups, mono)}</ul>${breakdownTable(groups, keyLabel, title)}`;
    parent.appendChild(card);
  }

  function breakdownSplit() {
    const grid = document.createElement('div');
    grid.className = 'grid2';
    main.appendChild(grid);
    barCard(grid, 'Spend by provider', byProvider.groups, false, 'provider', 'Provider');
    barCard(grid, 'Spend by model', byModel.groups, true, 'model', 'Model');
  }
  function breakdownStack() {
    const card = document.createElement('section');
    card.className = 'card';
    card.innerHTML = `<div class="tabsw"><h2 class="lbl">Where the spend went</h2><div class="seg" role="group" aria-label="Group by"><button aria-pressed="true">By provider</button><button aria-pressed="false">By model</button></div></div><ul class="rows" role="img" aria-label="${barAria(byProvider.groups, 'provider')}">${state === 'loading' ? '' : rowsHtml(byProvider.groups, false)}</ul>${state === 'loading' ? '' : breakdownTable(byProvider.groups, 'Provider', 'Spend by provider')}`;
    main.appendChild(card);
  }
  function breakdownLedger() {
    const mk = (groups, title, keyLabel, mono) => {
      const known = groups.filter((g) => g.spend_usd !== 'unknown');
      const total = known.reduce((a, g) => a + Number(g.spend_usd), 0);
      const max = Math.max(...known.map((g) => Number(g.spend_usd)));
      const body = groups.map((g) => {
        const unk = g.spend_usd === 'unknown';
        const v = unk ? 0 : Number(g.spend_usd);
        const note = unk ? `${plural(g.unpriced_requests, 'request', 'requests')}, no catalog price` : g.unpriced_requests ? `Lower bound: ${g.unpriced_requests} unpriced` : '';
        return `<tr><td class="${mono ? 'mono' : ''}">${g.key}${note ? `<span class="note">${note}</span>` : ''}</td><td>${n(g.requests)}</td><td class="${unk ? 'unk' : ''}">${usd(g.spend_usd)}</td><td>${unk ? '—' : Math.round((v / total) * 100) + '%'}</td><td class="barcell" aria-hidden="true">${unk ? '' : `<span class="inl" data-w="${(v / max) * 100}"></span>`}</td></tr>`;
      }).join('');
      return `<section class="card"><h2 class="lbl">${title}</h2><div class="scroll"><table class="ledger"><thead><tr><th scope="col">${keyLabel}</th><th scope="col">Requests</th><th scope="col">Spend</th><th scope="col">Share</th><th scope="col"><span hidden>Bar</span></th></tr></thead><tbody>${body}</tbody></table></div></section>`;
    };
    if (state === 'loading') return;
    main.insertAdjacentHTML('beforeend', mk(byProvider.groups, 'Spend by provider', 'Provider', false) + mk(byModel.groups, 'Spend by model', 'Model', true));
  }

  if (treatment === 'stack') { stack(); if (state !== 'error') breakdownStack(); }
  if (treatment === 'split') { split(); if (state !== 'error') breakdownSplit(); }
  if (treatment === 'ledger') { ledger(); if (state !== 'error') breakdownLedger(); }
  // Mock only: production sets widths from script through element.style too (CSP forbids style attributes in HTML).
  for (const f of document.querySelectorAll('[data-w]')) f.style.width = `${f.dataset.w}%`;
})();
