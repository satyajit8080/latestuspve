import { h, mount, $ } from '../ui/dom.js';
import { createDataTable } from '../ui/data-table.js';
import { dirChip, scoreCell, coverageMeter, gateBadges, freshBadge, emptyState } from '../ui/parts.js';
import { state, subscribe } from '../app/store.js';
import { adaptScanRows } from '../adapt/scanRow.js';
import { navigate, buildHash, replaceQuery } from '../app/router.js';
import { signed, num, usd, times, int, compact, isNum, DASH } from '../app/fmt.js';
import { freshness } from '../app/freshness.js';
import { marketSession } from '../app/session.js';
import { toast } from '../ui/toast.js';

const goodIf = (dir) => (r, old) => { if (!old) return 'flat'; const d = (r.changePct ?? 0) - (old.changePct ?? 0); return dir === 'bull' ? (d > 0 ? 'good' : 'bad') : dir === 'bear' ? (d < 0 ? 'good' : 'bad') : 'flat'; };
const tickScore = (r, old) => (old && isNum(old.score) && isNum(r.score) ? ((r.score > old.score) === (r.dir !== 'bear') ? 'good' : 'bad') : 'flat');
const colored = (v, d, suf = '') => h('span', { class: isNum(v) ? (v > 0 ? 'bull' : v < 0 ? 'bear' : '') : 'dim', title: isNum(v) ? null : 'unavailable' }, signed(v, d, suf));
export function ranksOf(rows) { const m = new Map(); rows.slice().sort((a, b) => (b.score ?? -1) - (a.score ?? -1)).forEach((r, i) => m.set(r.ticker, i + 1)); return m; }

export function renderScan(root, { query, runScan, cal, inspector, refresh }) {
  let q = { min: query.min || '0', dir: query.dir || '', tradeable: query.tradeable || '', gated: query.gated || '', sector: query.sector || '', q: (query.q || '').toUpperCase(), sort: query.sort || 'score', sd: query.sd || 'desc' };
  const persist = () => replaceQuery('scan', null, { min: q.min === '0' ? '' : q.min, dir: q.dir, tradeable: q.tradeable, gated: q.gated, sector: q.sector, q: q.q, sort: q.sort === 'score' ? '' : q.sort, sd: q.sd === 'desc' ? '' : q.sd });
  let prevRanks = new Map(state.prevRanks), allRows = [], curRanks = new Map();
  const cols = [
    { key: 'rank', label: '#', align: 'r', sort: true, value: (r) => curRanks.get(r.ticker), render: (r) => { const rk = curRanks.get(r.ticker), pr = prevRanks.get(r.ticker), d = pr && rk ? pr - rk : 0; return h('span', {}, String(rk ?? DASH), d ? h('span', { class: `rankdelta ${d > 0 ? 'bull' : 'bear'}`, title: `Moved ${d > 0 ? 'up' : 'down'} ${Math.abs(d)} since the last scan` }, `${d > 0 ? '▲' : '▼'}${Math.abs(d)}`) : null); }, firstDir: 1 },
    { key: 'ticker', label: 'Ticker', sticky: true, render: (r) => h('strong', { title: r.sector || null }, r.ticker), firstDir: 1 },
    { key: 'dir', label: 'Dir', value: (r) => (r.dir === 'bull' ? 1 : r.dir === 'bear' ? -1 : 0), render: (r) => dirChip(r.dir, r.signal) },
    { key: 'score', label: 'Score', align: 'r', value: (r) => (r.gated ? -1 : r.score), tick: tickScore, render: scoreCell },
    { key: 'coverage', hideM: true, label: 'Cover', render: (r) => coverageMeter(r.coverage) },
    { key: 'gates', hideM: true, label: 'Gates', value: (r) => r.gates.length, render: (r) => gateBadges(r.gates) },
    { key: 'price', hideM: true, label: 'Price', align: 'r', render: (r) => usd(r.price) },
    { key: 'changePct', hideM: true, label: 'Chg %', align: 'r', tick: goodIf('bull'), render: (r) => colored(r.changePct, 2, '%') },
    { key: 'vsVwapPct', hideM: true, label: 'vs VWAP', align: 'r', render: (r) => colored(r.vsVwapPct, 2, '%') },
    { key: 'rvol', hideM: true, label: 'RVOL', align: 'r', render: (r) => times(r.rvol) },
    { key: 'oiNet', hideM: true, label: 'Net OI Δ', align: 'r', render: (r) => colored(r.oiNet, 0) , value: (r) => r.oiNet },
    { key: 'ivr', hideM: true, label: 'IVR', align: 'r', render: (r) => int(r.ivr) },
    { key: 'updatedAt', label: 'Updated', align: 'r', render: (r) => freshBadge(r.updatedAt, state.session.state) },
  ];
  const table = createDataTable({ columns: cols, rowKey: (r) => r.ticker, live: true, label: 'Ranked options universe', rowClass: (r) => (isNum(r.score) && r.score >= 70 && !r.gated ? 'alert' : ''),
    onSelect: (r, click) => inspector.show(r), onOpen: (r) => navigate(buildHash('t', r.ticker)), onEscape: () => inspector.hide() });
  table.el.addEventListener('sortchange', (e) => { q.sort = e.detail.key; q.sd = e.detail.dir === 1 ? 'asc' : 'desc'; persist(); });
  const press = (b, on) => b.setAttribute('aria-pressed', String(!!on));
  const mkSeg = (items, get, set) => { const el = h('div', { class: 'seg', role: 'group' }); const btns = items.map(([label, val]) => { const b = h('button', { type: 'button', onclick: () => { set(val); sync(); draw(); persist(); } }, label); b._v = val; return b; }); const sync = () => btns.forEach((b) => press(b, get() === b._v)); btns.forEach((b) => el.append(b)); sync(); el._sync = sync; return el; };
  const minSeg = mkSeg([['All', '0'], ['70+', '70'], ['80+', '80'], ['90+', '90']], () => q.min, (v) => { q.min = v; });
  const dirSeg = mkSeg([['Any', ''], ['▲ Bull', 'bull'], ['▼ Bear', 'bear']], () => q.dir, (v) => { q.dir = v; });
  const gateSeg = mkSeg([['All', ''], ['Tradeable', 'tradeable'], ['Gated', 'gated']], () => (q.tradeable ? 'tradeable' : q.gated ? 'gated' : ''), (v) => { q.tradeable = v === 'tradeable' ? '1' : ''; q.gated = v === 'gated' ? '1' : ''; });
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Ticker  ( / )', value: q.q, dataset: { search: '1' }, aria: { label: 'Filter by ticker' }, oninput: (e) => { q.q = e.target.value.toUpperCase().trim(); draw(); persist(); } });
  const sector = h('select', { class: 'select', aria: { label: 'Sector' }, onchange: (e) => { q.sector = e.target.value; draw(); persist(); } }, h('option', { value: '' }, 'All sectors'));
  const count = h('span', { class: 'count num', role: 'status', aria: { live: 'polite' } });
  const meta = h('span', { class: 'muted' });
  const runBtn = h('button', { class: 'btn primary', onclick: runScan }, 'Run scan');
  const refBtn = h('button', { class: 'btn', onclick: async () => { await refresh(); toast('Snapshot refreshed from cache (no data-provider calls)'); }, title: 'Re-read the cached snapshot. Makes no Unusual Whales calls.' }, 'Refresh');
  const banners = h('div');
  const tableHost = h('div');
  const filtered = () => allRows.filter((r) => (q.min === '0' || (isNum(r.score) && r.score >= Number(q.min))) && (!q.dir || r.dir === q.dir) && (!q.tradeable || (r.actionable !== false && !r.gates.some((g) => g !== 'EARNINGS' && g !== 'PRICE_CONFLICT' && g !== 'INSUFFICIENT_DIRECTIONAL_EVIDENCE'))) && (!q.gated || r.gated || r.gates.length > 0) && (!q.sector || r.sector === q.sector) && (!q.q || r.ticker.includes(q.q)));
  function draw() {
    const snap = state.signals, ms = marketSession(Date.now(), cal), now = Date.now();
    const list = filtered(); curRanks = ranksOf(allRows);
    count.textContent = `${list.length} of ${allRows.length}`;
    const age = snap && snap.generatedAtMs ? now - snap.generatedAtMs : null, fr = freshness(age, ms.state);
    const sc = state.scan; runBtn.disabled = !!sc.running || (state.authInfo && state.authInfo.options && state.authInfo.options.configured === false);
    runBtn.title = sc.running ? 'A scan is already running' : (state.authInfo && state.authInfo.options && state.authInfo.options.configured === false ? 'Unusual Whales is not configured' : 'Scan the universe (spends Unusual Whales quota)');
    runBtn.textContent = sc.running ? `Scanning ${isNum(sc.done) && isNum(sc.total) ? sc.done + '/' + sc.total : '…'}` : 'Run scan';
    const bn = [];
    if (!ms.rth && ms.state !== 'HALF') bn.push(h('div', { class: 'banner', role: 'note' }, `Market ${ms.label.toLowerCase()}. ${snap ? 'Showing the last snapshot.' : ''} Scores outside regular trading hours are capped at 60.`));
    if (snap && ms.rth && fr.level === 'offline') bn.push(h('div', { class: 'banner warn', role: 'alert' }, `This snapshot is ${Math.round(age / 60000)} minutes old and the market is open. Run a scan for fresh scores.`));
    if (state.conn.failures >= 3) bn.push(h('div', { class: 'banner err', role: 'alert' }, 'Reconnecting to the server… the table below is the last data received.'));
    mount(banners, bn);
    if (!snap) { mount(tableHost, state.authInfo && state.authInfo.options && state.authInfo.options.configured === false ? emptyState('No data provider configured', 'Set OPTIONS_PROVIDER=uw and UNUSUAL_WHALES_API_TOKEN in .env, then restart the server.') : emptyState('No scan yet', 'Run a scan to rank the Unusual Whales universe.', h('button', { class: 'btn primary', onclick: runScan }, 'Run scan'))); meta.textContent = ''; return; }
    meta.textContent = `${snap.scored ?? '—'} scored · ${snap.skipped ?? 0} skipped · primary ${snap.primary || 'opt'}`;
    if (!allRows.length) { mount(tableHost, emptyState('Snapshot has no usable rows', 'The last scan produced no scored tickers.')); return; }
    if (!list.length) { mount(tableHost, emptyState('No tickers match the filters', `${allRows.length} tickers hidden by the current filters.`, h('button', { class: 'btn', onclick: () => { q = { ...q, min: '0', dir: '', tradeable: '', gated: '', sector: '', q: '' }; search.value = ''; sector.value = ''; [minSeg, dirSeg, gateSeg].forEach((s) => s._sync()); persist(); draw(); } }, 'Clear filters'))); return; }
    if (!tableHost.contains(table.el)) mount(tableHost, table.el);
    table.update(list, { sortState: { key: q.sort, dir: q.sd === 'asc' ? 1 : -1 } });
  }
  function load() {
    const snap = state.signals; if (!snap) { allRows = []; return; }
    allRows = adaptScanRows(snap.rows);
    const sectors = [...new Set(allRows.map((r) => r.sector).filter(Boolean))].sort();
    if (sector.options.length !== sectors.length + 1) { mount(sector, h('option', { value: '' }, 'All sectors'), sectors.map((s) => h('option', { value: s }, s))); sector.value = q.sector; }
    prevRanks = new Map(state.prevRanks);
  }
  mount(root,
    h('div', { class: 'page-head' }, h('h1', {}, 'Scan'), meta, h('span', { class: 'grow' }), h('span', { id: 'scan-fresh' }), refBtn, runBtn),
    banners, h('div', { class: 'filterbar', role: 'search' }, minSeg, dirSeg, gateSeg, search, sector, count), tableHost);
  const freshHost = $('#scan-fresh', root);
  const paintFresh = () => { const s = state.signals; mount(freshHost, s && s.generatedAtMs ? freshBadge(s.generatedAtMs, state.session.state) : h('span', { class: 'dim' }, 'No snapshot')); };
  load(); draw(); paintFresh();
  const unsub = subscribe((what) => { if (what === 'signals') { load(); draw(); paintFresh(); } else if (what === 'scan' || what === 'tick' || what === 'conn' || what === 'auth') { draw(); paintFresh(); } });
  return { destroy: unsub, focusSearch: () => search.focus() };
}
