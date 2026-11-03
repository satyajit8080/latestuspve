/* Options Signal Engine — client (thin shell).
   All scoring happens on the server (engine/pipeline.js). This file only does I/O, state and rendering:
   it never recomputes or re-labels a score. */

const state = { ui: { tab: 'signals' }, optProvider: null };

// ---------- dom + fmt helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
function fmt(n) { if (!isNum(n)) return '—'; const a = Math.abs(n); if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B'; if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M'; if (a >= 1e3) return (n / 1e3).toFixed(1) + 'k'; if (a < 1 && a > 0) return n.toFixed(3); return String(Math.round(n)); }
function pct(n, d = 0) { return isNum(n) ? (n * 100).toFixed(d) + '%' : '—'; }
function hhmmss(ts) { return new Date(ts).toTimeString().slice(0, 8); }
function ago(ts) { const s = Math.round((Date.now() - ts) / 1000); if (s < 60) return s + 's'; if (s < 3600) return Math.round(s / 60) + 'm'; return Math.round(s / 3600) + 'h'; }
const num = (s) => `<span class="num">${s}</span>`;
function tableHTML(cols, rows, empty) {
  if (!rows || !rows.length) return `<div class="empty">${empty || 'No data.'}</div>`;
  return `<table><thead><tr>${cols.map((c, i) => `<th${i ? ' style="text-align:right"' : ''}>${c}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td${i ? ' style="text-align:right"' : ''}>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

// ---------- api / auth ----------
async function api(path, params) {
  const q = params ? '?' + new URLSearchParams(params).toString() : '';
  const r = await fetch('/api' + path + q, { credentials: 'include' });
  if (r.status === 401) { showLogin(); throw new Error('unauthorized'); }
  return r.json();
}
async function checkStatus() { const s = await (await fetch('/auth/status', { credentials: 'include' })).json(); state.optProvider = s.options || null; return s; }
function showLogin() { $('#login').style.display = 'flex'; $('#app').style.display = 'none'; }
async function doLogin() {
  $('#lerr').textContent = '';
  const r = await fetch('/auth/login', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('#pw').value }) });
  if (r.status === 429) { $('#lerr').textContent = 'Too many attempts. Try again later.'; return; }
  if (!r.ok) { $('#lerr').textContent = r.status === 403 ? 'Wrong password.' : 'Login failed.'; return; }
  start();
}
async function doLogout() { await fetch('/auth/logout', { method: 'POST', credentials: 'include' }); location.reload(); }

let SCAN_POLL = null;
function scanStatusTxt(t) { const el = $('#scanStatus'); if (el) el.textContent = t || ''; }
function scanBtnBusy(busy) { const b = $('#sigRunScan'); if (!b) return; b.disabled = !!busy; b.textContent = busy ? 'Scanning…' : 'Run Scan'; }
async function runScan() {
  if (SCAN_POLL) return;
  scanBtnBusy(true); scanStatusTxt('starting…');
  try {
    const r = await fetch('/api/scan/run', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: 500 }) });
    const j = await r.json();
    if (!r.ok || !j.ok) { scanBtnBusy(false); scanStatusTxt((j.error || 'could not start') + (j.reason ? ` — ${j.reason}` : '')); return; }
    scanStatusTxt('scanning ' + (j.limit || '') + ' tickers — this uses API quota…');
    SCAN_POLL = setInterval(pollScan, 3000);
  } catch (e) { scanBtnBusy(false); scanStatusTxt('error: ' + e.message); }
}
async function pollScan() {
  try {
    const s = await (await fetch('/api/scan/status', { credentials: 'include' })).json();
    if (s.running) { scanStatusTxt('scanning…'); return; }
    clearInterval(SCAN_POLL); SCAN_POLL = null; scanBtnBusy(false);
    scanStatusTxt(s.lastOk ? 'done · ' + (s.message || '') : 'failed · ' + (s.message || ''));
    if (s.lastOk) renderSignals();
  } catch (e) { clearInterval(SCAN_POLL); SCAN_POLL = null; scanBtnBusy(false); scanStatusTxt('status error'); }
}

async function renderOptions() {
  const ticker = (($('#optTicker') && $('#optTicker').value) || 'AAPL').toUpperCase().trim();
  $('#optMeta').textContent = ticker;
  $('#optStatus').textContent = 'loading ' + ticker + '…';
  let r; try { r = await api('/options/' + encodeURIComponent(ticker)); } catch (e) { r = { ok: false, error: e.message }; }
  if (!r || !r.ok) {
    $('#optStatus').innerHTML = `<span class="bear">${esc((r && r.provider) || 'no provider')}</span>`;
    $('#optSummary').innerHTML = `<div class="card"><div class="bd" style="padding:16px"><b class="bear">Insufficient options data.</b> <span class="dim">${esc((r && r.error) || 'unavailable')}</span><div class="dim" style="margin-top:8px;font-size:12px">Set <span class="mono">OPTIONS_PROVIDER=uw</span> and <span class="mono">UNUSUAL_WHALES_API_TOKEN=</span>your UW token in <span class="mono">.env</span> on the server, then restart.</div></div></div>`;
    $('#optFeatures').innerHTML = ''; $('#optChain').innerHTML = '';
    return;
  }
  const sig = r.signal; const ch = r.chain; const fa = (ch && ch.fieldsAvailable) || {};
  $('#optStatus').innerHTML = `source <span class="mono">${esc(r.provider)}</span> · ${esc(r.ts ? hhmmss(new Date(r.ts).getTime()) : '')}`;

  const finalScore = sig.finalScore, tier = sig.tier;   // published by the server; never recomputed here
  const availPill = (k, label) => `<span class="dim" title="${label}">${label}: <b class="${fa[k] ? 'bull' : 'bear'}">${fa[k] ? 'AVAILABLE' : 'UNAVAILABLE'}</b></span>`;
  const dcl = sig.dir === 'bull' ? 'bull' : sig.dir === 'bear' ? 'bear' : '';
  const a = sig.agg || {};
  const kv = (k, v) => `<div class="f"><div class="k">${k}</div><div class="v">${v}</div></div>`;
  const gexTxt = isNum(a.gex) ? `<span class="${a.gex >= 0 ? 'bull' : 'bear'}">${a.gex >= 0 ? '+' : ''}${(a.gex / 1e6).toFixed(1)}M</span>` : '<span class="dim">unavailable (needs greeks+OI)</span>';
  $('#optSummary').innerHTML = `<div class="card"><div class="body" style="padding:16px">
    <div class="top" style="display:flex;align-items:center;gap:12px">
      <div><div class="tkr" style="font-size:20px">${esc(ticker)} <span class="dirbadge ${dcl === 'bull' ? 'b' : dcl === 'bear' ? 's' : 'n'}">${esc((sig.dir || 'neutral').toUpperCase())}</span></div>
      <div class="muted" style="font-size:12px">underlying ${isNum(ch.underlying && ch.underlying.price) ? '$' + ch.underlying.price.toFixed(2) : '—'} · data ${esc(sig.dataQualityStatus)} (${sig.dataQuality}%)</div></div>
      <div class="score" style="margin-left:auto;text-align:right"><div class="n ${dcl}" style="font-size:30px">${finalScore}</div><div class="l">${esc(tier)} · FINAL</div><div class="l dim" style="font-size:9px;letter-spacing:.06em">LIVE · RECOMPUTED NOW</div></div>
    </div>
    <div class="dl" style="margin-top:14px">
      ${kv('Options score', `<b>${sig.optionsScore}</b>`)} ${kv('Stock score', `<b>${sig.stockScore}</b>`)}
      ${kv('Primary engine', esc(sig.primaryEngine || 'opt'))} ${kv('Data quality', pct(sig.dataQuality / 100, 0))}
      ${kv('Call/Put vol', isNum(a.cpVolRatio) ? a.cpVolRatio.toFixed(2) : (a.cpVolRatio === Infinity ? '∞' : '—'))} ${kv('Vol/OI', isNum(a.volOIRatio) ? a.volOIRatio.toFixed(2) : '—')}
      ${kv('ATM IV', isNum(a.atmIV) ? (a.atmIV * 100).toFixed(0) + '%' : '—')} ${kv('GEX', gexTxt)}
      ${kv('Gamma flip', isNum(a.gammaFlip) ? '$' + a.gammaFlip : '—')} ${kv('Max pain', isNum(a.maxPain) ? '$' + a.maxPain : '—')}
      ${(sig.walls && (isNum(sig.walls.call) || isNum(sig.walls.put))) ? kv('Call/Put wall', `${isNum(sig.walls.call) ? '$' + sig.walls.call : '—'} / ${isNum(sig.walls.put) ? '$' + sig.walls.put : '—'}`) : ''}
      ${isNum(sig.ivRank) ? kv('IV rank', sig.ivRank.toFixed(0) + (isNum(sig.ivPercentile) ? ` <span class="dim">(pctl ${sig.ivPercentile.toFixed(0)})</span>` : '')) : ''}
    </div>
    <div class="cov" style="margin-top:12px;flex-wrap:wrap;gap:10px">${availPill('greeks', 'Greeks')} ${availPill('iv', 'IV')} ${availPill('oi', 'OI')} ${availPill('quotes', 'Quotes')} ${availPill('underlying', 'Underlying')} ${availPill('sweeps', 'Sweeps')}</div>
    <div class="disc" style="margin-top:12px">Score = options evidence x stock confirmation x data quality. It is a ranking/confidence number, not a probability of profit. Not financial advice.</div>
  </div></div>`;

  $('#shadowOut').innerHTML = sigV2Html(sig) || '<div class="dim" style="font-size:12px">v2 shadow unavailable for this ticker (needs signed flow).</div>';

  // features table
  $('#optFeatures').innerHTML = tableHTML(['Feature', 'Avail', 'Dir', 'Strength', 'Weight', 'Value', 'Note'],
    (sig.features || []).map((f) => [esc(f.label), f.avail ? '<span class="bull">✓</span>' : '<span class="dim">—</span>', f.dir > 0 ? '<span class="bull">bull</span>' : f.dir < 0 ? '<span class="bear">bear</span>' : '<span class="dim">·</span>', num((f.strength * 100).toFixed(0) + '%'), num((f.weight * 100).toFixed(0) + '%'), num(isNum(f.value) ? (+f.value).toFixed(3) : '—'), `<span class="dim">${esc(f.note || '')}</span>`]),
    'No option features.');

  // chain table (top by volume)
  $('#optChain').innerHTML = tableHTML(['Type', 'Strike', 'Exp', 'Vol', 'OI', 'IV', 'Δ', 'Γ', 'Bid', 'Ask'],
    (ch.contracts || []).map((c) => [`<span class="${c.type === 'call' ? 'bull' : 'bear'}">${esc(c.type)}</span>`, num(c.strike), `<span class="dim">${esc(c.expiration || '')}</span>`, num(c.volume ?? '—'), num(c.openInterest ?? '—'), num(isNum(c.iv) ? (c.iv * 100).toFixed(0) + '%' : '—'), num(isNum(c.delta) ? c.delta.toFixed(2) : '—'), num(isNum(c.gamma) ? c.gamma.toFixed(3) : '—'), num(isNum(c.bid) ? c.bid.toFixed(2) : '—'), num(isNum(c.ask) ? c.ask.toFixed(2) : '—')]),
    'No contracts returned.');
}
// =====================================================================
//  US OPTIONS SIGNALS (ranked scan table: production + shadow)
// =====================================================================
const SIG = { rows: [], meta: null, thr: 0, side: null, q: '', sortKey: 'productionScore', sortDir: -1 };
const sigNum = (x) => (isNum(x) ? x : null);
const sigCell = (x, d = '—') => (x == null || x === '' ? d : x);
function sigScoreClass(s) { return !isNum(s) ? 'dim' : s >= 80 ? 'bull' : s >= 65 ? 'bull' : s >= 50 ? '' : s >= 35 ? 'dim' : 'bear'; }
function sigSignalHtml(sig) { if (sig === 'CALL') return '<b class="bull">CALL</b>'; if (sig === 'PUT') return '<b class="bear">PUT</b>'; if (sig === 'WATCH') return '<span class="dim">WATCH</span>'; return '<span class="dim">—</span>'; }
function openTickerOptions(t) { $('#optTicker').value = t; setTab('options'); }

function sigFiltered() {
  let rows = SIG.rows.filter((r) => isNum(r.productionScore));
  if (SIG.thr > 0) rows = rows.filter((r) => r.productionScore >= SIG.thr);
  if (SIG.side === 'bull') rows = rows.filter((r) => r.dir === 'bull');
  if (SIG.side === 'bear') rows = rows.filter((r) => r.dir === 'bear');
  if (SIG.q) rows = rows.filter((r) => String(r.ticker).includes(SIG.q));
  const k = SIG.sortKey, dir = SIG.sortDir;
  rows.sort((a, b) => { const x = a[k], y = b[k]; if (!isNum(x) && !isNum(y)) return 0; if (!isNum(x)) return 1; if (!isNum(y)) return -1; return (x - y) * dir; });
  return rows;
}
function renderSigTable() {
  const rows = sigFiltered();
  const cols = [
    ['ticker', 'Ticker', 'left'], ['productionScore', 'Score', 'r'], ['v2Score', 'v2 (shadow)', 'r'],
    ['signal', 'Signal', 'left'], ['marketBias', 'Bias', 'left'], ['confidence', 'Conf', 'r'],
    ['price', 'Price', 'r'], ['changePct', 'Chg%', 'r'], ['vsVwapPct', 'vs VWAP', 'r'], ['ivRank', 'IVR', 'r'], ['optionsLiquidity', 'Liq', 'left'], ['sector', 'Sector', 'left'],
  ];
  const arrow = (k) => (SIG.sortKey === k ? (SIG.sortDir === -1 ? ' ▾' : ' ▴') : '');
  const th = cols.map(([k, label, a]) => `<th data-sortk="${k}" style="text-align:${a === 'r' ? 'right' : 'left'};cursor:pointer;padding:6px 10px;white-space:nowrap;border-bottom:1px solid rgba(255,255,255,.12);font-size:11px;color:#9aa" >${esc(label)}${arrow(k)}</th>`).join('');
  const biasCls = (b) => (b === 'STRONG' || b === 'BULLISH' ? 'bull' : b === 'BEARISH' ? 'bear' : b === 'AVOID' ? 'bear' : 'dim');
  const body = rows.map((r) => {
    const chg = isNum(r.changePct) ? `<span class="${r.changePct >= 0 ? 'bull' : 'bear'}">${r.changePct >= 0 ? '+' : ''}${r.changePct}%</span>` : '—';
    return `<tr data-tkr="${esc(r.ticker)}" style="cursor:pointer;border-bottom:1px solid rgba(255,255,255,.05)">
      <td style="padding:6px 10px;font-weight:600">${esc(r.ticker)}</td>
      <td style="padding:6px 10px;text-align:right"><b class="${sigScoreClass(r.productionScore)}">${sigCell(r.productionScore)}</b></td>
      <td style="padding:6px 10px;text-align:right" class="dim">${sigCell(r.v2Score)}</td>
      <td style="padding:6px 10px">${sigSignalHtml(r.signal)}</td>
      <td style="padding:6px 10px"><span class="${biasCls(r.marketBias)}">${sigCell(r.marketBias)}</span></td>
      <td style="padding:6px 10px;text-align:right" class="dim">${sigCell(r.confidence)}</td>
      <td style="padding:6px 10px;text-align:right">${isNum(r.price) ? '$' + r.price.toFixed(2) : '—'}</td>
      <td style="padding:6px 10px;text-align:right">${chg}</td>
      <td style="padding:6px 10px;text-align:right">${isNum(r.vsVwapPct) ? `<span class="${r.vsVwapPct >= 0 ? 'bull' : 'bear'}">${r.vsVwapPct >= 0 ? '+' : ''}${r.vsVwapPct}%</span>` : '<span class="dim">—</span>'}</td>
      <td style="padding:6px 10px;text-align:right" class="dim">${sigCell(r.ivRank)}</td>
      <td style="padding:6px 10px" class="dim">${sigCell(r.optionsLiquidity)}</td>
      <td style="padding:6px 10px" class="dim">${sigCell(r.sector)}</td>
    </tr>`;
  }).join('');
  $('#sigTable').innerHTML = rows.length
    ? `<table style="width:100%;border-collapse:collapse;font-size:12.5px"><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`
    : '<div class="dim" style="padding:24px;text-align:center">No signals match the current filters.</div>';
  $$('#sigTable th[data-sortk]').forEach((h) => h.onclick = () => { const k = h.dataset.sortk; if (SIG.sortKey === k) SIG.sortDir *= -1; else { SIG.sortKey = k; SIG.sortDir = (k === 'ticker' ? 1 : -1); } renderSigTable(); });
  $$('#sigTable tr[data-tkr]').forEach((tr) => tr.onclick = () => openTickerOptions(tr.dataset.tkr));
}
// ===== Claude Review (research archive UI — read-only) =====
const JR = { view: 'dash', offset: 0, limit: 50, total: 0 };
let JR_POLL = null;
function jrSet(v) { JR.view = v; $$('[data-jr]').forEach((c) => c.classList.toggle('on', c.dataset.jr === v)); if (v === 'dash') renderJrDash(); else if (v === 'signals') renderJrSignals(); else if (v === 'eval') renderJrEval(); else if (v === 'ready') renderJrReady(); else renderJrLearning(); }
async function renderJournal() { jrSet(JR.view); }
const jrPct = (v) => (isNum(v) ? `<span class="${v >= 0 ? 'bull' : 'bear'}">${v >= 0 ? '+' : ''}${v}%</span>` : '<span class="dim">—</span>');

async function renderJrDash() {
  const b = $('#jrBody'); b.innerHTML = '<div class="dim mono">loading…</div>';
  const r = await (await fetch('/api/journal/stats', { credentials: 'include' })).json();
  if (!r.ok) { b.innerHTML = `<div class="dim">${esc(r.error || 'unavailable')}</div>`; return; }
  const L = r.learning, T = L.totals;
  $('#jrMeta').textContent = `${T.signals} signals · ${T.resolved} resolved · ${r.pending} pending`;
  const card = (l, v, cl) => `<div class="kpi"><div class="l">${l}</div><div class="n ${cl || ''}">${v}</div></div>`;
  b.innerHTML = `<div class="kpis" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-bottom:14px">
      ${card('TOTAL SIGNALS', T.signals)}${card('WINNERS', T.winners, 'bull')}${card('LOSERS', T.losers, 'bear')}
      ${card('WIN RATE', isNum(L.winRate) ? L.winRate + '%' : '—')}
      ${card('AVG 30M', isNum(L.avg30mReturn) ? L.avg30mReturn + '%' : '—', L.avg30mReturn >= 0 ? 'bull' : 'bear')}
      ${card('AVG 1H', isNum(L.avg1hReturn) ? L.avg1hReturn + '%' : '—', L.avg1hReturn >= 0 ? 'bull' : 'bear')}
      ${card('BEST FACTOR', L.bestFactor ? esc(L.bestFactor.label) : '—')}${card('WORST FACTOR', L.worstFactor ? esc(L.worstFactor.label) : '—')}</div>
    ${T.resolved === 0 ? '<div class="dim" style="padding:10px;border:1px solid var(--line);border-radius:8px">No resolved outcomes yet. Signals resolve 30 minutes after they fire — press <b>Resolve Outcomes</b> once some have aged.</div>' : ''}
    <div class="dim mono" style="font-size:11px;margin-top:8px">${esc(L.note)}</div>`;
}

async function renderJrSignals() {
  const b = $('#jrBody'); b.innerHTML = '<div class="dim mono">loading…</div>';
  const q = new URLSearchParams({ offset: JR.offset, limit: JR.limit, sort: 'newest' });
  const r = await (await fetch('/api/journal/list?' + q, { credentials: 'include' })).json();
  if (!r.ok) { b.innerHTML = `<div class="dim">${esc(r.error || 'unavailable')}</div>`; return; }
  JR.total = r.total;
  if (!r.rows.length) { b.innerHTML = '<div class="dim" style="padding:10px">No journaled signals yet. Signals are recorded automatically when a scan or ticker analysis runs.</div>'; return; }
  const st = (s) => s === 'WIN' ? '<span class="bull">WIN</span>' : s === 'LOSS' ? '<span class="bear">LOSS</span>' : `<span class="dim">${s}</span>`;
  b.innerHTML = `<div style="overflow:auto"><table style="width:100%;border-collapse:collapse;font-size:12.5px" id="jrTable">
    <thead><tr class="dim" style="text-align:left">
      <th style="padding:6px 10px">TICKER</th><th style="padding:6px 10px">TIME</th><th style="padding:6px 10px">DIR</th>
      <th style="padding:6px 10px;text-align:right">SCORE</th><th style="padding:6px 10px;text-align:right">V2</th>
      <th style="padding:6px 10px;text-align:right">30M</th><th style="padding:6px 10px;text-align:right">60M</th><th style="padding:6px 10px">STATUS</th></tr></thead>
    <tbody>${r.rows.map((x) => `<tr data-id="${esc(x.id)}" style="border-top:1px solid var(--line);cursor:pointer">
      <td style="padding:6px 10px"><b>${esc(x.ticker)}</b></td>
      <td style="padding:6px 10px" class="dim mono">${esc(new Date(x.firedAt).toLocaleString())}</td>
      <td style="padding:6px 10px"><span class="${x.dir === 'bull' ? 'bull' : 'bear'}">${esc(x.signal)}</span></td>
      <td style="padding:6px 10px;text-align:right"><b>${x.score}</b></td>
      <td style="padding:6px 10px;text-align:right" class="dim">${isNum(x.v2Score) ? x.v2Score : '—'}</td>
      <td style="padding:6px 10px;text-align:right">${jrPct(x.r30m)}</td>
      <td style="padding:6px 10px;text-align:right">${jrPct(x.r1h)}</td>
      <td style="padding:6px 10px">${st(x.status)}</td></tr>`).join('')}</tbody></table></div>
    <div class="row" style="gap:10px;align-items:center;margin-top:10px" id="jrPager"></div>`;
  $$('#jrTable tr[data-id]').forEach((tr) => tr.onclick = () => openJrDetail(tr.dataset.id));
  const from = r.total ? JR.offset + 1 : 0, to = JR.offset + r.rows.length;
  $('#jrPager').innerHTML = `<button class="btn ghost" id="jrPrev" ${JR.offset <= 0 ? 'disabled' : ''}>‹ Prev</button><span class="dim mono">${from}–${to} of ${r.total}</span><button class="btn ghost" id="jrNext" ${to >= r.total ? 'disabled' : ''}>Next ›</button>`;
  if ($('#jrPrev')) $('#jrPrev').onclick = () => { JR.offset = Math.max(0, JR.offset - JR.limit); renderJrSignals(); };
  if ($('#jrNext')) $('#jrNext').onclick = () => { JR.offset += JR.limit; renderJrSignals(); };
}

async function openJrDetail(id) {
  const r = await (await fetch('/api/journal/signal/' + encodeURIComponent(id), { credentials: 'include' })).json();
  if (!r.ok) return;
  const s = r.signal, ex = s.explain || {}, pa = s.postAnalysis, en = s.entry || {}, oc = s.outcomes || {};
  const li = (xs) => (xs && xs.length ? '<ul style="margin:4px 0 0 16px;padding:0">' + xs.map((x) => `<li>${esc(typeof x === 'string' ? x : (x.label || x.note || JSON.stringify(x)))}</li>`).join('') + '</ul>' : '<div class="dim">none</div>');
  const fRow = (f) => `<tr style="border-top:1px solid var(--line)"><td style="padding:4px 8px">${esc(f.label)}</td><td style="padding:4px 8px;text-align:right">${f.strength}</td><td style="padding:4px 8px;text-align:right">${f.contribution ?? '—'}</td><td style="padding:4px 8px">${f.directional ? (f.agrees ? '<span class="bull">agrees</span>' : '<span class="bear">conflicts</span>') : '<span class="dim">confirming</span>'}</td></tr>`;
  const ocBlock = (h) => { const o = oc[h]; if (!o || o.status !== 'resolved') return `<div class="dim">${h}: ${o ? esc(o.status) : 'pending'}</div>`;
    return `<div><b>${h}</b> · stock ${o.stockPrice} (${jrPct(o.stockChangePct)}) · option ${o.optionPrice ?? '—'} (${jrPct(o.optionChangePct)}) · max favorable ${jrPct(o.maxFavorablePct)} · max adverse ${jrPct(o.maxAdversePct)}</div>`; };
  $('#sheet').innerHTML = `<button class="x" id="closeModal">✕</button>
    <h3 style="margin:0 0 2px">${esc(s.ticker)} <span class="${s.composite.dir === 'bull' ? 'bull' : 'bear'}">${s.composite.dir === 'bull' ? 'CALL' : 'PUT'}</span> · ${s.composite.finalScore}</h3>
    <div class="dim mono" style="font-size:11px;margin-bottom:10px">${esc(new Date(s.firedAt).toLocaleString())} · ${esc(s.id)}</div>
    <h4 style="margin:10px 0 4px">Why this call was generated</h4>
    <div style="font-size:12.5px">${esc(ex.summary || '—')}</div>
    <div class="dim" style="font-size:12px;margin-top:6px">${esc(ex.whyScoreReached || '')}</div>
    <h4 style="margin:12px 0 4px">Factors</h4>
    <table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr class="dim" style="text-align:left"><th style="padding:4px 8px">FACTOR</th><th style="padding:4px 8px;text-align:right">STRENGTH</th><th style="padding:4px 8px;text-align:right">CONTRIB</th><th style="padding:4px 8px">ROLE</th></tr></thead>
    <tbody>${[...(ex.strongestFactors || []), ...(ex.conflictingFactors || [])].filter((v, i, a) => a.findIndex((z) => z.key === v.key) === i).map(fRow).join('')}</tbody></table>
    <div style="font-size:12px;margin-top:8px"><b>Options flow:</b> ${esc(ex.optionsFlowReasoning || '—')}</div>
    <div style="font-size:12px"><b>Stock confirmation:</b> ${esc(ex.stockConfirmation || '—')}</div>
    <div style="font-size:12px"><b>Momentum:</b> ${esc(ex.momentumConfirmation || '—')}</div>
    <h4 style="margin:12px 0 4px">Reason codes</h4>
    ${(s.reasons && s.reasons.length) ? s.reasons.map((rc) => `<div style="font-size:12px"><span class="mono ${/CONFLICT|RISK|LOW_|NOT_CONFIRMED/.test(rc.code) ? 'bear' : 'bull'}">${esc(rc.code)}</span> <span class="dim">${esc(rc.explanation)}</span></div>`).join('') : '<div class="dim">none</div>'}
    <h4 style="margin:12px 0 4px">Risks / warnings at signal time</h4>${li(ex.risks)}
    <h4 style="margin:12px 0 4px">Entry (captured at signal time)</h4>
    <div style="font-size:12.5px">stock ${en.stockPrice ?? '—'} · option ${en.optionPrice ?? '—'} · vs VWAP ${isNum(en.vsVwapPct) ? en.vsVwapPct + '%' : '—'} · day ${isNum(en.changePct) ? en.changePct + '%' : '—'}</div>
    <h4 style="margin:12px 0 4px">Outcomes</h4>${ocBlock('15m')}${ocBlock('30m')}${ocBlock('60m')}${ocBlock('close')}
    <h4 style="margin:12px 0 4px">${pa ? (pa.verdict === 'WIN' ? 'Why it won' : 'Why it lost') : 'Post-trade analysis'}</h4>
    ${!pa ? '<div class="dim">Not yet resolved.</div>' : (pa.verdict === 'WIN'
      ? `<div style="font-size:12.5px">Return ${jrPct(pa.directionalReturnPct)} · top contributor: <b>${esc(pa.topContributor ? pa.topContributor.label : '—')}</b></div>${li(pa.whatConfirmed)}${pa.notes ? `<div class="dim" style="font-size:12px;margin-top:4px">${esc(pa.notes)}</div>` : ''}`
      : `<div style="font-size:12.5px">Return ${jrPct(pa.directionalReturnPct)}</div>
         <div style="font-size:12px;margin-top:6px"><b>Likely reason:</b> ${esc(pa.likelyReason)}</div>
         <div style="font-size:12px;margin-top:6px"><b>Factors that failed:</b></div>${li(pa.wrongAssumptions)}
         <div style="font-size:12px;margin-top:6px"><b>Warnings that were present:</b></div>${li(pa.missedWarnings)}
         ${pa.stockOptionsDisagreed ? '<div class="bear" style="font-size:12px;margin-top:6px">Stock and options data disagreed at entry.</div>' : ''}`)}
    <div class="dim mono" style="font-size:10px;margin-top:12px">Original signal data is immutable; outcomes are stored as separate append-only patches.</div>`;
  $('#modal').classList.add('on');
  $('#closeModal').onclick = () => $('#modal').classList.remove('on');
}

async function renderJrLearning() {
  const b = $('#jrBody'); b.innerHTML = '<div class="dim mono">loading…</div>';
  const r = await (await fetch('/api/journal/stats', { credentials: 'include' })).json();
  if (!r.ok) { b.innerHTML = `<div class="dim">${esc(r.error || 'unavailable')}</div>`; return; }
  const L = r.learning;
  const bucket = (x) => `<tr style="border-top:1px solid var(--line)"><td style="padding:4px 8px">${esc(x.range)}</td><td style="padding:4px 8px;text-align:right">${x.n}</td><td style="padding:4px 8px;text-align:right">${isNum(x.winRate) ? x.winRate + '%' : '—'}</td><td style="padding:4px 8px;text-align:right">${jrPct(x.avgReturn)}</td><td style="padding:4px 8px">${x.gated ? '<span class="dim">low sample</span>' : ''}</td></tr>`;
  const fac = (x) => `<tr style="border-top:1px solid var(--line)"><td style="padding:4px 8px">${esc(x.label)}</td><td style="padding:4px 8px;text-align:right">${x.n}</td><td style="padding:4px 8px;text-align:right">${isNum(x.winRate) ? x.winRate + '%' : '—'}</td><td style="padding:4px 8px;text-align:right">${jrPct(x.avgReturn)}</td><td style="padding:4px 8px">${x.gated ? '<span class="dim">low sample</span>' : ''}</td></tr>`;
  b.innerHTML = `<h4 style="margin:4px 0">Win rate by score range</h4>
    <table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr class="dim" style="text-align:left"><th style="padding:4px 8px">RANGE</th><th style="padding:4px 8px;text-align:right">N</th><th style="padding:4px 8px;text-align:right">WIN%</th><th style="padding:4px 8px;text-align:right">AVG RET</th><th></th></tr></thead><tbody>${L.scoreBuckets.map(bucket).join('')}</tbody></table>
    <h4 style="margin:14px 0 4px">Factor performance</h4>
    ${L.factorPerformance.length ? `<table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr class="dim" style="text-align:left"><th style="padding:4px 8px">FACTOR</th><th style="padding:4px 8px;text-align:right">N</th><th style="padding:4px 8px;text-align:right">WIN%</th><th style="padding:4px 8px;text-align:right">AVG RET</th><th></th></tr></thead><tbody>${L.factorPerformance.map(fac).join('')}</tbody></table>` : '<div class="dim">No resolved outcomes yet.</div>'}
    <h4 style="margin:14px 0 4px">Winning vs losing characteristics</h4>
    <div style="font-size:12.5px">${L.bestCharacteristics ? `<div><b>Winners:</b> avg score ${L.bestCharacteristics.avgScore}, avg options ${L.bestCharacteristics.avgOptionsScore}, stock-confirmed ${L.bestCharacteristics.stockConfirmRate}%</div>` : '<div class="dim">no winners yet</div>'}
    ${L.worstCharacteristics ? `<div><b>Losers:</b> avg score ${L.worstCharacteristics.avgScore}, avg options ${L.worstCharacteristics.avgOptionsScore}, stock-confirmed ${L.worstCharacteristics.stockConfirmRate}%</div>` : '<div class="dim">no losers yet</div>'}</div>
    <div class="dim mono" style="font-size:11px;margin-top:12px">${esc(L.note)}</div>`;
}


// v2 shadow scorer panel (spec phases 2-5). Advisory only — production score is unchanged.
function sigV2Html(sig) {
  const v = sig && sig.v2;
  if (!v || v.error || !isNum(v.score)) return '';
  const st = esc(v.state || '—');
  const cls = /STRONG_BULL|^BULL/.test(v.state) ? 'bull' : /BEAR/.test(v.state) ? 'bear' : 'dim';
  const comp = v.components || {};
  const bar = (k, val) => `<div style="display:flex;align-items:center;gap:6px;font-size:11.5px"><span class="dim" style="width:56px">${k}</span><span style="flex:1;height:5px;background:var(--line);border-radius:3px;overflow:hidden"><span style="display:block;height:100%;width:${isNum(val) ? Math.max(0, Math.min(100, val)) : 0}%;background:${isNum(val) ? 'var(--acc)' : 'transparent'}"></span></span><span class="mono" style="width:34px;text-align:right">${isNum(val) ? Math.round(val) : '—'}</span></div>`;
  return `<div style="margin-top:14px;border:1px solid var(--line);border-radius:8px;padding:10px">
    <div class="row" style="align-items:center;gap:8px"><b style="font-size:12.5px">v2 SHADOW SCORER</b>
      <span class="k">research</span><span class="dim mono" style="font-size:10px">${esc(v.version || '')}</span>
      <span style="margin-left:auto"><span class="${cls}"><b>${st}</b></span> <b>${v.score}</b>${v.gated ? ' <span class="bear">GATED</span>' : ''}</span></div>
    <div style="margin-top:8px;display:grid;gap:3px">${['flow','price','gamma','market','context'].map((k) => bar(k, comp[k])).join('')}</div>
    <div class="dim mono" style="font-size:10.5px;margin-top:6px">coverage ${v.coverage ?? '—'}% · combined multiplier ${v.multipliers ? v.multipliers.combined : '—'}${v.multipliers && v.multipliers.capped ? ' (capped)' : ''}${v.actionable ? ' · actionable' : ' · not actionable'}</div>
    ${(v.reasons && v.reasons.length) ? `<div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:4px">${v.reasons.map((r) => `<span class="mono ${/CONFLICT|RISK|LOW_|GATED|NOT_CONFIRMED/.test(r.code) ? 'bear' : 'bull'}" style="font-size:10px;border:1px solid var(--line);border-radius:4px;padding:1px 5px" title="${esc(r.explanation || '')}">${esc(r.code)}</span>`).join('')}</div>` : ''}
    ${(v.quality && v.quality.flags && v.quality.flags.length) ? `<div class="dim mono" style="font-size:10px;margin-top:5px">data gaps: ${v.quality.flags.map(esc).join(', ')}</div>` : ''}
    <div class="dim" style="font-size:10.5px;margin-top:6px">${esc(v.note || '')}</div></div>`;
}

async function renderJrEval() {
  const b = $('#jrBody'); b.innerHTML = '<div class="dim mono">computing…</div>';
  const r = await (await fetch('/api/journal/evaluation', { credentials: 'include' })).json();
  if (!r.ok) { b.innerHTML = `<div class="dim">${esc(r.error || 'unavailable')}</div>`; return; }
  const R = r.report, H = R.byHorizon;
  const g = (x) => (x && x.gated ? ' <span class="dim">(low sample)</span>' : '');
  const hRow = (k) => { const h = H[k]; if (!h) return ''; return `<tr style="border-top:1px solid var(--line)">
    <td style="padding:4px 8px"><b>${k}</b></td><td style="padding:4px 8px;text-align:right">${h.n}</td>
    <td style="padding:4px 8px;text-align:right">${isNum(h.hitRate) ? h.hitRate + '%' : '—'}</td>
    <td style="padding:4px 8px;text-align:right">${jrPct(h.avgReturn)}</td>
    <td style="padding:4px 8px;text-align:right">${h.rankIC.ic ?? '—'}${g(h.rankIC)}</td>
    <td style="padding:4px 8px;text-align:right">${h.v2RankIC ? (h.v2RankIC.ic ?? '—') : '—'}</td>
    <td style="padding:4px 8px;text-align:right">${isNum(h.topDecile.precision) ? h.topDecile.precision + '%' : '—'}</td>
    <td style="padding:4px 8px;text-align:right">${jrPct(h.avgMFE)}</td><td style="padding:4px 8px;text-align:right">${jrPct(h.avgMAE)}</td></tr>`; };
  const grp = (rows) => rows.length ? `<table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr class="dim" style="text-align:left"><th style="padding:4px 8px">GROUP</th><th style="padding:4px 8px;text-align:right">N</th><th style="padding:4px 8px;text-align:right">HIT%</th><th style="padding:4px 8px;text-align:right">AVG RET</th><th style="padding:4px 8px;text-align:right">MFE</th><th style="padding:4px 8px;text-align:right">MAE</th></tr></thead><tbody>${rows.map((x) => `<tr style="border-top:1px solid var(--line)"><td style="padding:4px 8px">${esc(String(x.key))}${g(x)}</td><td style="padding:4px 8px;text-align:right">${x.n}</td><td style="padding:4px 8px;text-align:right">${isNum(x.hitRate) ? x.hitRate + '%' : '—'}</td><td style="padding:4px 8px;text-align:right">${jrPct(x.avgReturn)}</td><td style="padding:4px 8px;text-align:right">${jrPct(x.avgMFE)}</td><td style="padding:4px 8px;text-align:right">${jrPct(x.avgMAE)}</td></tr>`).join('')}</tbody></table>` : '<div class="dim">no data yet</div>';
  const cal = (H['30m'] ? H['30m'].calibration : []).map((c) => `<tr style="border-top:1px solid var(--line)"><td style="padding:4px 8px">${esc(c.range)}${g(c)}</td><td style="padding:4px 8px;text-align:right">${c.n}</td><td style="padding:4px 8px;text-align:right">${isNum(c.hitRate) ? c.hitRate + '%' : '—'}</td><td style="padding:4px 8px;text-align:right">${jrPct(c.avgReturn)}</td></tr>`).join('');
  b.innerHTML = `<div class="dim mono" style="font-size:11px;margin-bottom:8px">${R.totals.evaluated} evaluated of ${R.totals.signals} signals · ${R.totals.bullish} bull / ${R.totals.bearish} bear</div>
    <h4 style="margin:4px 0">By horizon</h4>
    <table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr class="dim" style="text-align:left"><th style="padding:4px 8px">HORIZON</th><th style="padding:4px 8px;text-align:right">N</th><th style="padding:4px 8px;text-align:right">HIT%</th><th style="padding:4px 8px;text-align:right">AVG RET</th><th style="padding:4px 8px;text-align:right">RANK IC</th><th style="padding:4px 8px;text-align:right">v2 IC</th><th style="padding:4px 8px;text-align:right">TOP DEC</th><th style="padding:4px 8px;text-align:right">MFE</th><th style="padding:4px 8px;text-align:right">MAE</th></tr></thead><tbody>${['15m','30m','60m','close'].map(hRow).join('')}</tbody></table>
    <h4 style="margin:14px 0 4px">Score calibration (30m)</h4>
    <table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr class="dim" style="text-align:left"><th style="padding:4px 8px">SCORE</th><th style="padding:4px 8px;text-align:right">N</th><th style="padding:4px 8px;text-align:right">HIT%</th><th style="padding:4px 8px;text-align:right">AVG RET</th></tr></thead><tbody>${cal}</tbody></table>
    <h4 style="margin:14px 0 4px">By v2 state</h4>${grp(R.byV2State || [])}
    <h4 style="margin:14px 0 4px">By gamma regime</h4>${grp(R.byGammaRegime)}
    <h4 style="margin:14px 0 4px">By time of day</h4>${grp(R.byTimeOfDay)}
    <h4 style="margin:14px 0 4px">By ticker</h4>${grp(R.byTicker)}
    <div class="dim mono" style="font-size:11px;margin-top:12px">${esc(R.note)}</div>`;
}

async function renderJrReady() {
  const b = $('#jrBody'); b.innerHTML = '<div class="dim mono">loading…</div>';
  const r = await (await fetch('/api/research/readiness', { credentials: 'include' })).json();
  if (!r.ok) { b.innerHTML = `<div class="dim">${esc(r.error || 'unavailable')}</div>`; return; }
  const R = r.readiness, uw = r.uw || {};
  const stateCls = (s) => s === 'READY' ? 'bull' : s === 'WARMING_UP' ? '' : 'bear';
  const row = (l, v) => `<tr style="border-top:1px solid var(--line)"><td style="padding:4px 8px" class="dim">${l}</td><td style="padding:4px 8px;text-align:right">${v}</td></tr>`;
  const num = (v, suf = '') => (isNum(v) ? v + suf : '<span class="dim">—</span>');
  const gate = R.gate || { checks: [] };
  b.innerHTML = `<h4 style="margin:4px 0">V2 RESEARCH STATUS</h4>
    <table style="width:100%;border-collapse:collapse;font-size:12.5px"><tbody>
      ${row('Signals journaled', R.signals)}
      ${row('Resolved 15m', R.resolved['15m'])}${row('Resolved 30m', R.resolved['30m'])}${row('Resolved 60m', R.resolved['60m'])}${row('Resolved close', R.resolved.close)}
      ${row('RVOL', `<span class="${stateCls(R.features.rvol)}">${esc(R.features.rvol)}</span>`)}
      ${row('IV SKEW', `<span class="${stateCls(R.features.ivSkew)}">${esc(R.features.ivSkew)}</span>`)}
      ${row('SECTOR', `<span class="${stateCls(R.features.sector)}">${esc(R.features.sector)}</span>`)}
      ${row('MACRO', `<span class="${stateCls(R.features.macro)}">${esc(R.features.macro)}</span>`)}
      ${row('V1 Rank IC', num(R.metrics.v1RankIC))}${row('V2 Rank IC', num(R.metrics.v2RankIC))}
      ${row('V1 Top Decile', num(R.metrics.v1TopDecile, '%'))}${row('V2 Top Decile', num(R.metrics.v2TopDecile, '%'))}
      ${row('V2 STATUS', `<b>${esc(R.v2Status)}</b>`)}
      ${row('PROMOTION', `<b class="${R.promotion === 'NOT_READY' ? 'bear' : 'bull'}">${esc(R.promotion)}</b>`)}
    </tbody></table>
    <h4 style="margin:14px 0 4px">Promotion gate (${gate.passedCount}/${gate.totalChecks})</h4>
    ${gate.checks.map((c) => `<div style="font-size:12px"><span class="${c.passed ? 'bull' : 'bear'}">${c.passed ? '✓' : '✗'}</span> <span class="mono">${esc(c.name)}</span> <span class="dim">${esc(c.detail)}</span></div>`).join('')}
    <h4 style="margin:14px 0 4px">UW API</h4>
    <table style="width:100%;border-collapse:collapse;font-size:12.5px"><tbody>
      ${row('Provider', esc(uw.provider || '—') + (uw.keyMasked ? ` <span class="mono dim">${esc(uw.keyMasked)}</span>` : ''))}
      ${row('Requests this scan', num(uw.requestsThisScan))}${row('Requests total', num(uw.requestsTotal))}
      ${row('Per-minute used', `${num(uw.perMinuteUsed)} / ${num(uw.perMinuteLimit)}`)}
      ${row('UW quota remaining', uw.uwRemaining == null ? '<span class="dim">not exposed by UW</span>' : uw.uwRemaining)}
      ${row('Failed requests', num(uw.failures))}
    </tbody></table>
    <div class="dim mono" style="font-size:11px;margin-top:10px">data source: ${esc(R.dataSource)} · ${esc(R.note)}</div>
    <div class="dim mono" style="font-size:11px;margin-top:4px">${esc(gate.note || '')}</div>`;
}

async function jrResolve() {
  if (JR_POLL) return;
  const btn = $('#jrResolve'); btn.disabled = true; btn.textContent = 'Resolving…';
  $('#jrResolveStatus').textContent = 'fetching outcome data…';
  try {
    const r = await fetch('/api/journal/resolve', { method: 'POST', credentials: 'include' });
    const j = await r.json();
    if (!r.ok || !j.ok) { btn.disabled = false; btn.textContent = 'Resolve Outcomes'; $('#jrResolveStatus').textContent = j.error || 'could not start'; return; }
    JR_POLL = setInterval(async () => {
      const s = await (await fetch('/api/journal/resolve/status', { credentials: 'include' })).json();
      if (s.running) return;
      clearInterval(JR_POLL); JR_POLL = null; btn.disabled = false; btn.textContent = 'Resolve Outcomes';
      $('#jrResolveStatus').textContent = (s.lastOk ? 'done · ' : 'failed · ') + (s.message || '');
      jrSet(JR.view);
    }, 3000);
  } catch (e) { btn.disabled = false; btn.textContent = 'Resolve Outcomes'; $('#jrResolveStatus').textContent = 'error'; }
}

function renderSigTop() {
  const top = SIG.rows.filter((r) => isNum(r.productionScore)).sort((a, b) => b.productionScore - a.productionScore).slice(0, 5);
  if (!top.length) { $('#sigTop').innerHTML = ''; return; }
  $('#sigTop').innerHTML = '<div style="display:flex;gap:8px;flex-wrap:wrap">' + top.map((r) => `<span class="chip" data-tkr="${esc(r.ticker)}" style="cursor:pointer">${esc(r.ticker)} <b class="${sigScoreClass(r.productionScore)}">${r.productionScore}</b> ${sigSignalHtml(r.signal)}</span>`).join('') + '</div>';
  $$('#sigTop [data-tkr]').forEach((c) => c.onclick = () => openTickerOptions(c.dataset.tkr));
}
async function renderSignals() {
  $('#sigStatus').textContent = 'loading signals…';
  let r; try { r = await api('/signals/us', { limit: 500 }); } catch (e) { r = { ok: false, error: e.message }; }
  if (!r || !r.ok) { $('#sigStatus').innerHTML = `<span class="bear">${esc((r && r.error) || 'unavailable')}</span>`; $('#sigTable').innerHTML = ''; $('#sigTop').innerHTML = ''; return; }
  if (!r.available) {
    $('#sigMeta').textContent = '';
    $('#sigStatus').innerHTML = `<span class="bear">${esc(r.dataStatus || 'DATA UNAVAILABLE')}</span> — ${esc(r.reason || 'no scan yet')}`;
    $('#sigTable').innerHTML = ''; $('#sigTop').innerHTML = ''; return;
  }
  SIG.rows = r.rows || []; SIG.meta = r;
  const age = isNum(r.ageSeconds) ? (r.ageSeconds < 90 ? r.ageSeconds + 's ago' : Math.round(r.ageSeconds / 60) + 'm ago') : '';
  $('#sigMeta').textContent = `${r.scored}/${r.count} scored · ${age}`;
  const statusCls = r.dataStatus === 'MARKET DATA LIVE' ? 'bull' : 'dim';
  $('#sigStatus').innerHTML = `<span class="${statusCls}">${esc(r.dataStatus)}</span> · updated ${esc(age)} · primary <b>${esc(r.primary)}</b> · <span class="dim">${esc(r.note || '')}</span>`;
  renderSigTop(); renderSigTable();
}

async function runAiAnalysis() {
  const ticker = (($('#optTicker') && $('#optTicker').value) || '').trim().toUpperCase();
  if (!ticker) { $('#aiStatus').innerHTML = '<span class="warn">Enter a ticker in the box above first.</span>'; return; }
  $('#aiStatus').textContent = 'running multi-agent analysis…'; $('#aiOut').innerHTML = '';
  let r; try { r = await (await fetch('/api/ai/analyze/' + encodeURIComponent(ticker), { method: 'POST' })).json(); } catch (e) { r = { ok: false, error: e.message }; }
  if (!r || !r.ok) { $('#aiStatus').innerHTML = `<span class="bear">${esc((r && r.error) || 'AI unavailable')}</span>`; return; }
  const ai = r.ai || {}; const det = { score: ai.deterministicScore, dir: ai.deterministicDirection, tier: ai.deterministicTier };
  $('#aiStatus').innerHTML = `model <span class="mono">${esc(r.model || '—')}</span>${r.cached ? ' · cached' : ''}`;
  const chip = (v) => `<span class="${v === 'bullish' ? 'bull' : v === 'bearish' ? 'bear' : 'dim'}">${esc(v)}</span>`;
  const analyst = (name, a) => `<div class="card" style="margin:0"><div class="hd" style="padding:8px 12px"><h3 style="font-size:12px">${esc(name)}</h3><span style="margin-left:auto">${chip(a.view)} <span class="dim">${a.confidence != null ? a.confidence : '—'}</span></span></div><div class="bd" style="padding:8px 12px;font-size:12px">${(a.points || []).map((p) => '• ' + esc(p)).join('<br>') || '<span class="dim">—</span>'}</div></div>`;
  $('#aiOut').innerHTML = `
    <div class="card" style="margin:0 0 10px;border-color:#2a3550"><div class="bd" style="display:flex;gap:20px;flex-wrap:wrap;font-size:12.5px;padding:10px 14px">
      <div><div class="dim" style="font-size:10px;text-transform:uppercase">Deterministic signal (authority)</div><b>${det.score != null ? det.score : '—'}</b> · ${chip(det.dir === 'bull' ? 'bullish' : det.dir === 'bear' ? 'bearish' : 'neutral')} · ${esc(det.tier || '—')}</div>
      <div style="border-left:1px solid #2a3550;padding-left:20px"><div class="dim" style="font-size:10px;text-transform:uppercase">AI view (advisory)</div>${chip(ai.aiView)} · conf <b>${ai.aiConfidence != null ? ai.aiConfidence : '—'}</b></div>
    </div></div>
    <div class="row" style="gap:10px">${analyst('Flow', ai.analysts.flow)}${analyst('Positioning / GEX', ai.analysts.positioning)}${analyst('Technical', ai.analysts.technical)}${analyst('News', ai.analysts.news)}</div>
    <div class="row" style="gap:10px;margin-top:10px">
      <div class="card" style="flex:1;margin:0;border-color:#1f4a2f"><div class="hd" style="padding:8px 12px"><h3 style="font-size:12px;color:#3fb950">Bull case</h3></div><div class="bd" style="padding:8px 12px;font-size:12px">${esc(ai.bullCase.thesis)}<br>${(ai.bullCase.points || []).map((p) => '• ' + esc(p)).join('<br>')}</div></div>
      <div class="card" style="flex:1;margin:0;border-color:#5a1f1f"><div class="hd" style="padding:8px 12px"><h3 style="font-size:12px;color:#f85149">Bear case</h3></div><div class="bd" style="padding:8px 12px;font-size:12px">${esc(ai.bearCase.thesis)}<br>${(ai.bearCase.points || []).map((p) => '• ' + esc(p)).join('<br>')}</div></div>
    </div>
    <div class="card" style="margin-top:10px"><div class="hd" style="padding:8px 12px"><h3 style="font-size:12px">Risk review · <span class="${ai.riskReview.level === 'high' ? 'bear' : ai.riskReview.level === 'low' ? 'bull' : 'warn'}">${esc(ai.riskReview.level)}</span></h3></div><div class="bd" style="padding:8px 12px;font-size:12px">${(ai.riskReview.risks || []).map((p) => '• ' + esc(p)).join('<br>') || '<span class="dim">—</span>'}</div></div>
    <div class="card" style="margin-top:10px;border-color:#3a3a5a"><div class="hd" style="padding:8px 12px"><h3 style="font-size:12px">AI summary</h3></div><div class="bd" style="padding:8px 12px;font-size:12.5px">${esc(ai.summary.text)}</div></div>
    <div class="dim" style="font-size:11px;margin-top:8px">${esc(ai.disclaimer || 'AI analysis is advisory and does not affect the Signal Score.')}</div>`;
}

async function renderStatus() {
  const el = $('#statusBody'); el.innerHTML = '<div class="dim mono">loading…</div>';
  let m; try { m = await api('/_monitor'); } catch (e) { el.innerHTML = `<div class="bear">${esc(e.message)}</div>`; return; }
  const row = (k, v) => `<tr><td class="dim" style="padding:6px 10px">${esc(k)}</td><td style="padding:6px 10px">${v}</td></tr>`;
  const prov = m.optionsProvider || {};
  el.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:12.5px"><tbody>
    ${row('Production engine', `<span class="mono">${esc(m.optionsEngineVersion || '—')}</span>`)}
    ${row('Shadow challenger (v2)', `<span class="mono">${esc(m.v2Version || '—')}</span>`)}
    ${row('Published score from', `<b>${esc(m.primary || 'opt')}</b> <span class="dim">(validated/promotion.json; edited by a person)</span>`)}
    ${row('Data provider', esc(prov.name || prov.provider || '—') + (prov.configured === false ? ' <span class="bear">not configured</span>' : ''))}
    ${row('UW requests this scan / total', `${(m.uw && m.uw.requestsThisScan) ?? '—'} / ${(m.uw && m.uw.requestsTotal) ?? '—'}`)}
    ${row('AI (advisory)', m.ai && m.ai.enabled ? `on · <span class="mono">${esc(m.ai.model || '')}</span>` : '<span class="dim">off</span>')}
  </tbody></table>`;
}

function setTab(t) {
  state.ui.tab = t;
  $$('.navbtn').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
  $$('.page').forEach((p) => p.classList.toggle('active', p.dataset.page === t));
  if (t === 'options') renderOptions();
  if (t === 'signals') renderSignals();
  if (t === 'journal') renderJournal();
  if (t === 'status') renderStatus();
}
function wire() {
  $('#loginBtn').onclick = doLogin;
  $('#pw').onkeydown = (e) => { if (e.key === 'Enter') doLogin(); };
  $('#logoutBtn').onclick = doLogout;
  $('#maphX').onclick = () => { $('#maph').classList.remove('show'); try { localStorage.setItem('sig_maph', '1'); } catch {} };
  try { if (!localStorage.getItem('sig_maph')) $('#maph').classList.add('show'); } catch { $('#maph').classList.add('show'); }
  $$('.navbtn').forEach((b) => b.onclick = () => setTab(b.dataset.tab));
  $('#optGo').onclick = () => renderOptions();
  $('#optTicker').onkeydown = (e) => { if (e.key === 'Enter') renderOptions(); };
  $$('[data-sigthr]').forEach((c) => c.onclick = () => { $$('[data-sigthr]').forEach((x) => x.classList.remove('on')); c.classList.add('on'); SIG.thr = Number(c.dataset.sigthr); renderSigTop(); renderSigTable(); });
  $$('[data-sigside]').forEach((c) => c.onclick = () => { const s = c.dataset.sigside; if (SIG.side === s) { SIG.side = null; c.classList.remove('on'); } else { SIG.side = s; $$('[data-sigside]').forEach((x) => x.classList.remove('on')); c.classList.add('on'); } renderSigTop(); renderSigTable(); });
  $('#sigSearch').oninput = (e) => { SIG.q = e.target.value.toUpperCase().trim(); renderSigTable(); };
  $('#sigRefresh').onclick = () => renderSignals();
  $('#sigRunScan').onclick = () => runScan();
  $$('[data-jr]').forEach((c) => c.onclick = () => jrSet(c.dataset.jr));
  $('#jrResolve').onclick = () => jrResolve();
  $('#aiRun').onclick = () => runAiAnalysis();
  $('#statusRefresh').onclick = () => renderStatus();
  $('#modal').onclick = (e) => { if (e.target.id === 'modal') $('#modal').classList.remove('on'); };
  document.onkeydown = (e) => { if (e.key === 'Escape') $('#modal').classList.remove('on'); };
}
function start() { $('#login').style.display = 'none'; $('#app').style.display = 'grid'; setTab(state.ui.tab || 'signals'); }   // no polling loop: Run Scan is the only trigger
async function boot() { wire(); const s = await checkStatus(); if (s.authed) start(); else showLogin(); }
boot();
