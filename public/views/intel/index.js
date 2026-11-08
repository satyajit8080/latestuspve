import { h, mount } from '../../ui/dom.js';
import { ago, isNum, DASH } from '../../app/fmt.js';
import { INTEL_TABS } from './tabs.js';
import { createIntelData } from './data.js';
import { modeChip } from './common.js';
import { renderScanner } from './scanner.js';
import { renderFlow } from './flow.js';
import { renderGex } from './gex.js';
import { renderPositioning } from './positioning.js';
import { renderVolatility } from './volatility.js';
import { renderTop } from './top.js';
import { renderDetail } from './detail.js';
import { renderBacktest } from './backtest.js';

const VIEWS = { scanner: renderScanner, flow: renderFlow, gex: renderGex, positioning: renderPositioning, volatility: renderVolatility, top: renderTop };
export function renderIntel(root, { param, rest = [] }) {
  const data = createIntelData(); const detail = param === 't'; const tab = detail ? 't' : (INTEL_TABS.some(([k]) => k === param) ? param : 'scanner');
  const head = h('div'), tabs = h('nav', { class: 'tabs intel', 'aria-label': 'Options Intelligence sections' }, INTEL_TABS.map(([k, label]) => h('a', { href: `#/intel/${k}`, 'aria-current': k === tab ? 'page' : null }, label))), body = h('div');
  const snapSel = h('select', { class: 'select', aria: { label: 'Snapshot' }, onchange: (e) => data.setSnapshot(e.target.value) }, h('option', { value: '' }, 'Latest'));
  const runBtn = h('button', { class: 'btn primary', onclick: () => data.runScan() }, 'Run scan'); let snapsLoaded = 0;
  function drawHead() {
    const st = data.status, L = data.latest, run = st && st.scan && st.scan.running, lim = st && st.limiter;
    const mode = data.snapshot ? 'HISTORICAL' : (L && L.mode) || null; runBtn.disabled = !!run || !!(st && !st.configured) || !!data.snapshot; runBtn.textContent = run ? `Scanning ${st.scan.stage || ''} ${isNum(st.scan.done) ? `${st.scan.done}/${st.scan.total}` : '…'}` : 'Run scan';
    if (st && st.snapshots && st.snapshots.count !== snapsLoaded) { snapsLoaded = st.snapshots.count; fetch('/api/intel/snapshots', { credentials: 'include' }).then((r) => r.json()).then((j) => { const cur = snapSel.value; snapSel.replaceChildren(h('option', { value: '' }, 'Latest'), ...(j.snapshots || []).slice().reverse().map((s) => h('option', { value: `${s.date}/${s.time}` }, `${s.date} ${s.time.slice(0, 2)}:${s.time.slice(2)} ET`))); snapSel.value = cur; }).catch(() => {}); }
    mount(head, h('div', { class: 'intel-head' }, h('h1', {}, 'Options Intelligence'), modeChip(mode), L ? h('span', { class: 'hint num' }, `${data.snapshot ? 'Stored snapshot' : 'Snapshot'} ${ago(Date.parse(L.generatedAt))} ago${L.partial ? ` · ${L.stage === 'deep' ? 'analysing in depth' : 'screening'} ${isNum(L.done) ? `${L.done}/${L.total}` : ''}` : ''}`) : h('span', { class: 'hint' }, 'No scan yet'),
      st ? h('span', { class: `chip ${st.configured ? 'ok' : 'gate'}`, title: st.configured ? 'Unusual Whales provider configured' : 'No provider configured (set OPTIONS_PROVIDER=uw and the token in .env)' }, st.configured ? 'UW connected' : 'UW not configured') : null, lim && isNum(lim.requestsLastMinute ?? lim.perMinuteUsed) ? h('span', { class: 'hint num' }, `${lim.requestsLastMinute ?? lim.perMinuteUsed}/min`) : null,
      L && L.schemaWarnings && Object.keys(L.schemaWarnings).length ? h('span', { class: 'chip gate', title: JSON.stringify(L.schemaWarnings) }, `${Object.keys(L.schemaWarnings).length} schema warning(s)`) : (L ? h('span', { class: 'chip' }, 'schema ok') : null),
      L && L.counts ? h('span', { class: 'hint num' }, `${L.counts.bull} bull · ${L.counts.bear} bear · ${L.counts.noTrade} no trade · ${L.counts.deep} deep / ${L.counts.rows}`) : null, h('span', { class: 'grow' }), snapSel, runBtn),
      data.error ? h('div', { class: 'banner err', role: 'alert' }, data.error) : null, st && !st.configured ? h('div', { class: 'banner warn' }, 'Options Intelligence needs an options provider. Add OPTIONS_PROVIDER=uw and UNUSUAL_WHALES_API_TOKEN to .env on the server and restart.') : null,
      st && st.legacyScanRunning ? h('div', { class: 'banner warn' }, 'The Scan page is running; both share one Unusual Whales rate limit.') : null);
  }
  const unsub = data.subscribe(drawHead); drawHead();
  let view; if (detail) view = renderDetail(body, data, (rest[0] || '').toUpperCase()); else if (tab === 'backtest') view = renderBacktest(body, data); else view = VIEWS[tab](body, data);
  mount(root, head, tabs, body, h('p', { class: 'hint' }, 'Unusual Whales data (US stocks). Evidence summaries for research, not predictions, probabilities of profit or advice. Options can lose all of their premium.'));
  data.start();
  return { destroy() { unsub(); if (view && view.destroy) view.destroy(); data.destroy(); } };
}
