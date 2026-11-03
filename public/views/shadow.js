import { h, mount } from '../ui/dom.js';
import { api } from '../app/api.js';
import { state, subscribe } from '../app/store.js';
import { adaptScanRows } from '../adapt/scanRow.js';
import { createDataTable } from '../ui/data-table.js';
import { emptyState, aiShadowChip, errorState } from '../ui/parts.js';
import { navigate, buildHash } from '../app/router.js';
import { num, isNum, DASH, signed } from '../app/fmt.js';

export function renderShadow(root) {
  let alive = true;
  const chip = (dir) => h('span', { class: 'chip shadow' }, dir === 'bull' ? '▲ BULL' : dir === 'bear' ? '▼ BEAR' : '● —');
  const cols = [
    { key: 'ticker', label: 'Ticker', sticky: true, render: (r) => h('strong', {}, r.ticker), firstDir: 1 },
    { key: 'v2dir', label: 'v2 dir', value: (r) => (r.v2.dir === 'bull' ? 1 : r.v2.dir === 'bear' ? -1 : null), render: (r) => (r.v2.dir ? chip(r.v2.dir) : h('span', { class: 'dim', title: 'v2 unavailable for this ticker' }, DASH)) },
    { key: 'v2score', label: 'v2 score', align: 'r', value: (r) => r.v2.score, render: (r) => h('span', { class: 'shadow-c' }, isNum(r.v2.score) ? String(r.v2.score) : DASH) },
    { key: 'v2cov', label: 'v2 coverage', align: 'r', value: (r) => r.v2.coverage, render: (r) => (isNum(r.v2.coverage) ? `${r.v2.coverage}%` : DASH) },
    { key: 'prod', label: 'Production (reference)', render: (r) => h('span', { class: 'dim' }, `${r.dir === 'bull' ? '▲' : r.dir === 'bear' ? '▼' : '●'} ${isNum(r.score) ? r.score : DASH}`) },
  ];
  const table = createDataTable({ columns: cols, rowKey: (r) => r.ticker, label: 'v2 shadow universe', onOpen: (r) => navigate(buildHash('t', r.ticker)) });
  const tableHost = h('div'), gateHost = h('div'), evalHost = h('div');
  function draw() {
    const rows = adaptScanRows(state.signals && state.signals.rows).filter((r) => r.v2.dir || isNum(r.v2.score));
    if (!state.signals) mount(tableHost, emptyState('No scan yet', 'Run a scan on the Scan page to populate the shadow universe.'));
    else if (!rows.length) mount(tableHost, emptyState('No v2 signals in this snapshot', 'v2 needs same-session signed flow for a ticker.'));
    else { mount(tableHost, table.el); table.update(rows, { sortState: { key: 'v2score', dir: -1 } }); }
    const g = state.readiness && state.readiness.readiness && state.readiness.readiness.gate;
    mount(gateHost, g ? h('div', { class: 'stack' }, h('p', { class: 'muted' }, `Promotion gate: ${g.promotion === 'ELIGIBLE_FOR_REVIEW' ? 'eligible for human review' : 'not ready'} (${g.passedCount}/${g.totalChecks} checks). There is no promote button: promotion is a person editing validated/promotion.json.`),
      h('table', { class: 'ledger' }, h('thead', {}, h('tr', {}, ['Check', 'Result', 'Detail'].map((x) => h('th', {}, x)))), h('tbody', {}, g.checks.map((c) => h('tr', {}, h('td', {}, c.name.replace(/_/g, ' ')), h('td', {}, h('span', { class: c.passed ? 'bull' : 'gated' }, c.passed ? '✓ pass' : '✗ not yet')), h('td', { class: 'muted' }, c.detail)))))) : h('p', { class: 'muted' }, 'Readiness not loaded yet.'));
  }
  mount(root,
    h('div', { class: 'page-head' }, h('h1', {}, 'Shadow'), aiShadowChip()),
    h('div', { class: 'banner shadow', role: 'note' }, `Research only. The published score comes from the “${(state.authInfo && state.authInfo.primary) || 'opt'}” engine (validated/promotion.json). Nothing on this page changes it.`),
    h('div', { class: 'stack' },
      h('section', { class: 'panel' }, h('header', {}, h('h2', {}, 'v2 universe')), h('div', { class: 'body' }, tableHost)),
      h('section', { class: 'panel' }, h('header', {}, h('h2', {}, 'v2 evaluation (30m)')), h('div', { class: 'body' }, evalHost)),
      h('section', { class: 'panel' }, h('header', {}, h('h2', {}, 'Promotion readiness')), h('div', { class: 'body' }, gateHost))));
  draw();
  (async () => { try { const r = await api('/api/journal/evaluation'); if (!alive) return; const m = r.data && r.data.report && r.data.report.byHorizon && r.data.report.byHorizon['30m'] && r.data.report.byHorizon['30m'].v2;
    const ic = m && m.pooledIC; mount(evalHost, m && ic && isNum(ic.n) && ic.n > 0 ? h('div', { class: 'kpis' }, [['Pooled IC (n)', `${isNum(ic.ic) ? num(ic.ic, 3) : DASH} (${ic.n})`], ['Cross-sectional IC', m.crossSectional && isNum(m.crossSectional.meanIC) ? `${num(m.crossSectional.meanIC, 3)} (t ${num(m.crossSectional.tStat, 1)})` : DASH], ['Top-decile precision', m.topDecile && isNum(m.topDecile.precision) ? `${m.topDecile.precision}%` : DASH]].map(([l, n]) => h('div', { class: 'kpi' }, h('div', { class: 'l' }, l), h('div', { class: 'n' }, n)))) : h('p', { class: 'muted' }, 'No resolved v2 observations yet.')); } catch { if (alive) mount(evalHost, errorState('Cannot reach the server.')); } })();
  const unsub = subscribe((w) => { if (w === 'signals' || w === 'readiness') draw(); });
  return { destroy() { alive = false; unsub(); } };
}
