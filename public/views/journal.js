import { h, mount } from '../ui/dom.js';
import { api } from '../app/api.js';
import { state, subscribe } from '../app/store.js';
import { createDataTable } from '../ui/data-table.js';
import { dirChip, emptyState, errorState, skeleton, gateBadges } from '../ui/parts.js';
import { openDialog } from '../ui/dialog.js';
import { toast } from '../ui/toast.js';
import { replaceQuery, navigate, buildHash } from '../app/router.js';
import { signed, num, usd, int, pct, etStamp, isNum, DASH, compact } from '../app/fmt.js';

const ret = (v) => h('span', { class: isNum(v) ? (v > 0 ? 'bull' : v < 0 ? 'bear' : '') : 'dim', title: isNum(v) ? null : 'not resolved yet' }, signed(v, 2, '%'));
const TABS = [['blotter', 'Blotter'], ['evaluation', 'Evaluation'], ['learning', 'Learning']];

export function renderJournal(root, { query }) {
  let tab = TABS.some(([k]) => k === query.tab) ? query.tab : 'blotter';
  const host = h('div'); let alive = true; let cleanup = () => {};
  const resolveBtn = h('button', { class: 'btn', onclick: async () => {
    const r = await api('/api/journal/resolve', { method: 'POST' });
    if (r.ok && r.data && r.data.ok) toast('Resolving outcomes… (uses Unusual Whales quota)'); else toast((r.data && r.data.error) || 'Could not start', 'err');
  }, title: 'Resolve due outcome checkpoints (15m/30m/60m) from intraday bars. Spends Unusual Whales quota.' }, 'Resolve outcomes');
  const tabs = h('div', { class: 'seg', role: 'tablist' }, TABS.map(([k, l]) => h('button', { role: 'tab', type: 'button', aria: { pressed: String(k === tab), selected: String(k === tab) }, onclick: () => { tab = k; replaceQuery('journal', null, { tab }); sync(); show(); } }, l)));
  const sync = () => [...tabs.children].forEach((b, i) => { b.setAttribute('aria-pressed', String(TABS[i][0] === tab)); b.setAttribute('aria-selected', String(TABS[i][0] === tab)); });
  const unsub = subscribe((w) => { if (w === 'resolve') { const r = state.resolve; resolveBtn.disabled = !!r.running; resolveBtn.textContent = r.running ? 'Resolving…' : 'Resolve outcomes'; } });
  mount(root, h('div', { class: 'page-head' }, h('h1', {}, 'Journal'), tabs, h('span', { class: 'grow' }), resolveBtn), host);
  function show() { cleanup(); cleanup = () => {}; mount(host, skeleton(8)); const f = { blotter, evaluation, learning }[tab]; f(host, query, (c) => { cleanup = c; }, () => alive); }
  show();
  return { destroy() { alive = false; unsub(); cleanup(); }, focusSearch() { const i = host.querySelector('[data-search]'); if (i) i.focus(); } };
}

function blotter(host, query, setCleanup, isAlive) {
  let f = { ticker: query.ticker || '', dir: query.dir || '', status: query.status || '', scoreMin: query.min || '70', sort: query.sort || 'newest', offset: 0, limit: 50 };
  const cols = [
    { key: 'firedAt', label: 'Fired (ET)', sort: false, render: (r) => etStamp(Date.parse(r.firedAt)) },
    { key: 'ticker', label: 'Ticker', sort: false, render: (r) => h('strong', {}, r.ticker) },
    { key: 'dir', label: 'Dir', sort: false, render: (r) => dirChip(r.dir, r.signal) },
    { key: 'score', label: 'Score', align: 'r', sort: false, render: (r) => String(r.score ?? DASH) },
    { key: 'gated', label: 'Gated', sort: false, render: (r) => (r.gated ? h('span', { class: 'chip gate' }, 'GATED') : h('span', { class: 'dim' }, DASH)) },
    { key: 'entryStock', label: 'Entry', align: 'r', sort: false, render: (r) => usd(r.entryStock) },
    { key: 'entryOption', label: 'Opt entry', align: 'r', sort: false, render: (r) => usd(r.entryOption) },
    { key: 'r15', label: '15m', align: 'r', sort: false, render: (r) => ret(r.r15m) },
    { key: 'r30', label: '30m', align: 'r', sort: false, render: (r) => ret(r.r30m) },
    { key: 'r60', label: '60m', align: 'r', sort: false, render: (r) => ret(r.r1h) },
    { key: 'status', label: 'Status', sort: false, render: (r) => h('span', { class: r.status === 'WIN' ? 'bull' : r.status === 'LOSS' ? 'bear' : 'dim' }, r.status) },
  ];
  const table = createDataTable({ columns: cols, rowKey: (r) => r.id, sortable: false, label: 'Signal blotter', onOpen: (r) => openDetail(r.id), onSelect: (r, click) => { if (click) openDetail(r.id); } });
  const input = (k, ph, w) => h('input', { class: 'input', placeholder: ph, value: f[k], dataset: k === 'ticker' ? { search: '1' } : {}, aria: { label: ph }, oninput: (e) => { f[k] = e.target.value.toUpperCase(); debounce(); } });
  const sel = (k, opts, label) => h('select', { class: 'select', aria: { label }, onchange: (e) => { f[k] = e.target.value; f.offset = 0; load(); persist(); } }, opts.map(([l, v]) => h('option', { value: v, selected: f[k] === v }, l)));
  let t = 0; const debounce = () => { clearTimeout(t); t = setTimeout(() => { f.offset = 0; load(); persist(); }, 250); };
  const persist = () => replaceQuery('journal', null, { tab: 'blotter', ticker: f.ticker, dir: f.dir, status: f.status, min: f.scoreMin === '70' ? '' : f.scoreMin, sort: f.sort === 'newest' ? '' : f.sort });
  const count = h('span', { class: 'count num', role: 'status', aria: { live: 'polite' } });
  const out = h('div'); const pager = h('div', { class: 'page-head' });
  mount(host, h('div', { class: 'filterbar', role: 'search' }, input('ticker', 'Ticker', 90), sel('dir', [['Any direction', ''], ['Bull', 'bull'], ['Bear', 'bear']], 'Direction'), sel('status', [['Any status', ''], ['Pending', 'PENDING'], ['Partial', 'PARTIAL'], ['Win', 'WIN'], ['Loss', 'LOSS']], 'Status'),
    sel('scoreMin', [['All scores', '0'], ['Alert threshold (≥70)', '70'], ['≥80', '80'], ['≥90', '90']], 'Minimum score'), sel('sort', [['Newest', 'newest'], ['Oldest', 'oldest'], ['Highest score', 'score_desc'], ['Best return', 'best'], ['Worst return', 'worst']], 'Sort'), count), out, pager);
  async function load() {
    const q = new URLSearchParams({ offset: f.offset, limit: f.limit, sort: f.sort }); if (f.ticker) q.set('ticker', f.ticker); if (f.dir) q.set('dir', f.dir); if (f.status) q.set('status', f.status); if (f.scoreMin !== '0') q.set('scoreMin', f.scoreMin);
    let r; try { r = await api('/api/journal/list?' + q); } catch { if (isAlive()) mount(out, errorState('Cannot reach the server.', load)); return; }
    if (!isAlive()) return;
    if (!r.ok || !r.data || !r.data.ok) return mount(out, errorState((r.data && r.data.error) || 'Journal unavailable', load));
    const d = r.data; count.textContent = `${d.total} signals`;
    if (!d.rows.length) { mount(out, emptyState('No journal rows', f.scoreMin !== '0' || f.ticker || f.dir || f.status ? 'No signals match these filters.' : 'Signals are journaled when a scan or ticker analysis runs.', f.scoreMin !== '0' ? h('button', { class: 'btn', onclick: () => { f.scoreMin = '0'; load(); } }, 'Show all scores') : null)); mount(pager); return; }
    mount(out, table.el); table.update(d.rows);
    const from = f.offset + 1, to = f.offset + d.rows.length;
    mount(pager, h('button', { class: 'btn', disabled: f.offset <= 0, onclick: () => { f.offset = Math.max(0, f.offset - f.limit); load(); } }, '‹ Prev'), h('span', { class: 'muted num' }, `${from}–${to} of ${d.total}`), h('button', { class: 'btn', disabled: to >= d.total, onclick: () => { f.offset += f.limit; load(); } }, 'Next ›'));
  }
  load();
}

async function openDetail(id) {
  const body = h('div', {}, skeleton(6)); const dlg = openDialog({ title: 'Signal', body });
  let r; try { r = await api('/api/journal/signal/' + encodeURIComponent(id)); } catch { return mount(body, errorState('Cannot reach the server.')); }
  if (!r.ok || !r.data || !r.data.ok) return mount(body, errorState((r.data && r.data.error) || 'Not found'));
  const s = r.data.signal, c = s.composite || {}, ex = s.explain || {}, oc = s.outcomes || {}, en = s.entry || {};
  dlg.el.querySelector('h2').textContent = `${s.ticker} · ${etStamp(Date.parse(s.firedAt))}`;
  const kv = (k, v) => h('div', {}, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v));
  mount(body, h('div', { class: 'stack' },
    h('div', { class: 'kv' }, kv('Dir', dirChip(c.dir, null)), kv('Score', String(c.finalScore ?? DASH)), kv('Raw score', isNum(c.rawScore) ? String(c.rawScore) : DASH), kv('Tier', c.tier || DASH), kv('Engine', s.optionsEngineVersion || c.optionsEngineVersion || DASH), kv('Gates', gateBadges(c.gateReasons))),
    ex.summary ? h('p', {}, ex.summary) : h('p', { class: 'muted' }, 'No production explanation (shadow-only row, or the signal predates explanations).'),
    ex.whyScoreReached ? h('p', { class: 'muted' }, ex.whyScoreReached) : null,
    (s.reasons || []).length ? h('div', {}, h('h3', {}, 'Reason codes'), h('div', { class: 'gates' }, s.reasons.map((x) => h('span', { class: 'chip', title: x.explanation || '' }, x.code)))) : null,
    (ex.risks || []).length ? h('div', {}, h('h3', {}, 'Risks'), h('ul', {}, ex.risks.map((x) => h('li', {}, x)))) : null,
    h('div', {}, h('h3', {}, 'Entry'), h('div', { class: 'kv' }, kv('Stock', usd(en.stockPrice)), kv('Option', usd(en.optionPrice)), kv('vs VWAP', signed(en.vsVwapPct, 2, '%')), kv('Day change', signed(en.changePct, 2, '%')))),
    h('div', {}, h('h3', {}, 'Outcomes'), h('table', { class: 'ledger' }, h('thead', {}, h('tr', {}, ['Checkpoint', 'Status', 'Return', 'MFE', 'MAE', 'vs SPY'].map((x) => h('th', {}, x)))), h('tbody', {}, ['15m', '30m', '60m', 'close'].map((k) => { const o = oc[k] || {}; return h('tr', {}, h('td', {}, k), h('td', {}, o.status || 'pending'), h('td', {}, ret(o.directionalReturnPct)), h('td', { class: 'num' }, signed(o.maxFavorablePct, 2, '%')), h('td', { class: 'num' }, signed(o.maxAdversePct, 2, '%')), h('td', { class: 'num' }, signed(o.benchmarkReturnPct, 2, '%'))); })))),
    h('p', { class: 'dim' }, 'This record is immutable. Outcomes are appended separately and never change the original signal.')));
}

function metricRow(label, m) { return h('tr', {}, h('td', {}, label), h('td', { class: 'num' }, isNum(m && m.n) ? String(m.n) : DASH), h('td', { class: 'num' }, isNum(m && m.hitRate) ? `${m.hitRate}%` : DASH), h('td', { class: 'num' }, signed(m && m.avgReturn, 2, '%'))); }
async function evaluation(host, query, setCleanup, isAlive) {
  let r; try { r = await api('/api/journal/evaluation'); } catch { return mount(host, errorState('Cannot reach the server.', () => evaluation(host, query, setCleanup, isAlive))); }
  if (!isAlive()) return;
  if (!r.ok || !r.data || !r.data.ok) return mount(host, errorState((r.data && r.data.error) || 'Evaluation unavailable'));
  const rep = r.data.report; let ver = rep.engineVersion;
  const body = h('div', { class: 'stack' });
  const draw = () => {
    const R = (rep.byVersion && rep.byVersion[ver]) || rep;
    const ic = (x) => (x && isNum(x.ic) ? num(x.ic, 3) : DASH), ci = (x) => (x && isNum(x.lo) ? `[${num(x.lo, 2)}, ${num(x.hi, 2)}]` : DASH);
    mount(body,
      h('div', { class: 'kpis' }, [['Signals', R.totals.signals], ['Evaluated (30m)', R.totals.evaluated], ['Bullish', R.totals.bullish], ['Bearish', R.totals.bearish]].map(([l, n]) => h('div', { class: 'kpi' }, h('div', { class: 'l' }, l), h('div', { class: 'n' }, String(n)))),
      h('section', { class: 'panel' }, h('header', {}, h('h2', {}, 'By horizon'), h('span', { class: 'dim' }, 'rows with n < 30 are indicative only')), h('div', { class: 'body' }, h('div', { class: 'tablewrap' }, h('table', { class: 'ledger' }, h('thead', {}, h('tr', {}, ['Horizon', 'n', 'Hit rate', 'Avg return', 'Pooled IC (95% CI)', 'Cross-sectional IC (t)', 'Top-decile precision', 'Adj. avg (SPY)'].map((x) => h('th', {}, x)))),
        h('tbody', {}, Object.entries(R.byHorizon).map(([hz, m]) => h('tr', { class: m.gated ? 'dim' : '' }, h('td', {}, hz), h('td', { class: 'num' }, String(m.n)), h('td', { class: 'num' }, isNum(m.hitRate) ? `${m.hitRate}%` : DASH), h('td', { class: 'num' }, signed(m.avgReturn, 2, '%')),
          h('td', { class: 'num' }, `${ic(m.rankIC)} ${ci(m.rankICci)}`), h('td', { class: 'num' }, m.crossSectionalIC && isNum(m.crossSectionalIC.meanIC) ? `${num(m.crossSectionalIC.meanIC, 3)} (${num(m.crossSectionalIC.tStat, 1)})` : DASH),
          h('td', { class: 'num' }, m.topDecile && isNum(m.topDecile.precision) ? `${m.topDecile.precision}% vs ${m.topDecile.baseline}%` : DASH), h('td', { class: 'num' }, signed(m.adjusted && m.adjusted.avgReturn, 2, '%')))))))),
          (() => { const m = R.byHorizon['30m']; return m && m.baselines ? h('p', { class: 'dim' }, `Baselines to beat (30m): random IC ${ic(m.baselines.random)} · momentum-only IC ${ic(m.baselines.momentumOnly && m.baselines.momentumOnly.pooledIC)}`) : null; })())),
      h('section', { class: 'panel' }, h('header', {}, h('h2', {}, 'Calibration (30m)')), h('div', { class: 'body' }, h('table', { class: 'ledger' }, h('thead', {}, h('tr', {}, ['Score band', 'n', 'Hit rate', 'Avg return'].map((x) => h('th', {}, x)))), h('tbody', {}, (R.byScoreBucket || []).map((b) => metricRow(b.range, { n: b.n, hitRate: b.hitRate, avgReturn: b.avgReturn })))))),
      h('div', { class: 'grid2' }, [['By gamma regime', R.byGammaRegime], ['By time of day', R.byTimeOfDay], ['By market regime', R.byMarketRegime], ['By RVOL', R.byRvol]].map(([t, g]) => h('section', { class: 'panel' }, h('header', {}, h('h2', {}, t)), h('div', { class: 'body' }, g && g.length ? h('table', { class: 'ledger' }, h('thead', {}, h('tr', {}, ['Group', 'n', 'Hit rate', 'Avg return'].map((x) => h('th', {}, x)))), h('tbody', {}, g.map((x) => metricRow(x.key, x)))) : h('p', { class: 'muted' }, 'No data yet.')))))); 
  };
  const versions = (rep.versions || []).length ? h('div', { class: 'filterbar' }, h('label', { class: 'muted', for: 'ev-ver' }, 'Engine version'), h('select', { class: 'select', id: 'ev-ver', onchange: (e) => { ver = e.target.value; draw(); } }, rep.versions.map((v) => h('option', { value: v, selected: v === ver }, v))), h('span', { class: 'dim' }, 'Versions are never pooled.')) : null;
  if (!rep.versions || !rep.versions.length) return mount(host, emptyState('No journal data yet', 'Evaluation appears after signals are journaled and their outcomes resolved.'));
  mount(host, versions, body); draw();
}

async function learning(host, query, setCleanup, isAlive) {
  let r; try { r = await api('/api/journal/stats?horizon=60m'); } catch { return mount(host, errorState('Cannot reach the server.', () => learning(host, query, setCleanup, isAlive))); }
  if (!isAlive()) return;
  if (!r.ok || !r.data || !r.data.ok) return mount(host, errorState((r.data && r.data.error) || 'Unavailable'));
  const L = r.data.learning;
  if (!L.totals.resolved) return mount(host, emptyState('Nothing resolved yet', `${L.totals.signals} signals journaled, none with a resolved 60m outcome. Press “Resolve outcomes”.`));
  mount(host, h('div', { class: 'stack' },
    h('div', { class: 'kpis' }, [['Resolved (60m)', L.totals.resolved], ['Win rate', isNum(L.winRate) ? `${L.winRate}%` : DASH], ['Avg return', signed(L.avgReturn, 2, '%')], ['Avg MFE', signed(L.avgMaxFavorable, 2, '%')], ['Avg MAE', signed(L.avgMaxAdverse, 2, '%')]].map(([l, n]) => h('div', { class: 'kpi' }, h('div', { class: 'l' }, l), h('div', { class: 'n' }, String(n))))),
    h('section', { class: 'panel' }, h('header', {}, h('h2', {}, 'Score buckets')), h('div', { class: 'body' }, h('table', { class: 'ledger' }, h('thead', {}, h('tr', {}, ['Band', 'n', 'Win rate', 'Avg return'].map((x) => h('th', {}, x)))), h('tbody', {}, L.scoreBuckets.map((b) => h('tr', { class: b.gated ? 'dim' : '' }, h('td', {}, b.range), h('td', { class: 'num' }, String(b.n)), h('td', { class: 'num' }, isNum(b.winRate) ? `${b.winRate}%` : DASH), h('td', { class: 'num' }, signed(b.avgReturn, 2, '%')))))))),
    h('section', { class: 'panel' }, h('header', {}, h('h2', {}, 'Factors'), h('span', { class: 'dim' }, 'only samples where the factor agreed with the call')), h('div', { class: 'body' }, (L.factorPerformance || []).length ? h('table', { class: 'ledger' }, h('thead', {}, h('tr', {}, ['Factor', 'n', 'Win rate', 'Avg return'].map((x) => h('th', {}, x)))), h('tbody', {}, L.factorPerformance.map((f) => h('tr', { class: f.gated ? 'dim' : '' }, h('td', {}, f.label), h('td', { class: 'num' }, String(f.n)), h('td', { class: 'num' }, isNum(f.winRate) ? `${f.winRate}%` : DASH), h('td', { class: 'num' }, signed(f.avgReturn, 2, '%')))))) : h('p', { class: 'muted' }, 'No factor data yet.')))));
}
