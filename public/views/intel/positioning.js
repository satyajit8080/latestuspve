import { h } from '../../ui/dom.js';
import { isNum, DASH, pct } from '../../app/fmt.js';
import { listView } from './list-view.js';
import { stateChip, usdC, tone, sgn, num0, interpretPositioning } from './common.js';

export function renderPositioning(host, data) {
  const cols = [
    { key: 'ticker', label: 'Ticker', sticky: true, firstDir: 1, render: (r) => h('strong', {}, r.ticker) }, { key: 'state', label: 'Signal', value: (r) => (r.state === 'BULL' ? 2 : r.state === 'BEAR' ? -2 : 0), render: stateChip },
    { key: 'oiCallChange', label: 'Call OI change', align: 'r', render: (r) => h('span', { class: tone(r.oiCallChange) }, num0(r.oiCallChange)) }, { key: 'oiPutChange', label: 'Put OI change', align: 'r', render: (r) => h('span', { class: tone(r.oiPutChange === 0 ? 0 : -r.oiPutChange) }, num0(r.oiPutChange)) },
    { key: 'oiImbalance', label: 'OI imbalance', align: 'r', title: '(call change − put change) / total |change|; published after the prior session', render: (r) => h('span', { class: tone(r.oiImbalance) }, sgn(r.oiImbalance)) }, { key: 'volOiHits', label: 'Vol > OI contracts', align: 'r', render: (r) => (isNum(r.volOiHits) ? String(r.volOiHits) : DASH) },
    { key: 'imbalance', label: 'Flow imbalance', align: 'r', render: (r) => h('span', { class: tone(r.imbalance) }, sgn(r.imbalance)) }, { key: 'openingShare', label: 'Opening', align: 'r', render: (r) => (isNum(r.openingShare) ? pct(r.openingShare) : DASH) }, { key: 'multiLegShare', label: 'Multi-leg', align: 'r', render: (r) => (isNum(r.multiLegShare) ? pct(r.multiLegShare) : DASH) },
    { key: 'totalPremium', label: 'Premium', align: 'r', render: (r) => usdC(r.totalPremium) }, { key: 'read', label: 'Interpretation', sort: false, hideM: true, render: interpretPositioning },
  ];
  return listView(host, data, { banner: h('div', { class: 'banner warn', role: 'note' }, 'Open interest is updated through clearing, not in real time, and is not a buyer-versus-seller ledger. Volume above OI is a screening clue, not proof that positions were opened.'),
    spec: [{ key: 'q', type: 'text', label: 'Ticker', ph: 'Ticker' }, { key: 'lean', type: 'select', label: 'OI lean', options: [['Any OI lean', ''], ['Call OI building', 'call'], ['Put OI building', 'put']] }], defaults: { q: '', lean: '' },
    source: (d) => (d.latest && d.latest.available !== false ? d.latest.rows.filter((r) => r.deep && isNum(r.oiImbalance)) : null), apply: (rows, f) => rows.filter((r) => (!f.q || r.ticker.includes(f.q)) && (!f.lean || (f.lean === 'call' ? r.oiImbalance > 0.25 : r.oiImbalance < -0.25))), cols, label: 'Institutional positioning', sort: { key: 'oiImbalance', dir: -1 }, empty: 'Run a scan: open-interest change is analysed for the most active tickers.' });
}
