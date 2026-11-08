import { h } from '../../ui/dom.js';
import { isNum, DASH, signed } from '../../app/fmt.js';
import { listView } from './list-view.js';
import { stateChip, usdC, px, tone, distPct } from './common.js';

const lvl = (level, price) => (isNum(level) ? h('span', {}, px(level), ' ', h('span', { class: `hint ${tone(distPct(level, price))}` }, isNum(distPct(level, price)) ? signed(distPct(level, price) * 100, 1, '%') : '')) : DASH);
export function renderGex(host, data) {
  const cols = [
    { key: 'ticker', label: 'Ticker', sticky: true, firstDir: 1, render: (r) => h('strong', {}, r.ticker) }, { key: 'state', label: 'Signal', value: (r) => (r.state === 'BULL' ? 2 : r.state === 'BEAR' ? -2 : 0), render: stateChip }, { key: 'price', label: 'Price', align: 'r', render: (r) => px(r.price) },
    { key: 'regime', label: 'Gamma regime', value: (r) => (r.regime === 'negative' ? -1 : r.regime === 'positive' ? 1 : null), render: (r) => (r.regime ? (r.regime === 'negative' ? 'Negative (moves can amplify)' : 'Positive (moves tend to dampen)') : DASH) },
    { key: 'netGamma', label: 'Net GEX', align: 'r', render: (r) => (isNum(r.netGamma) ? usdC(r.netGamma) : DASH) }, { key: 'gammaFlip', label: 'Gamma flip', align: 'r', value: (r) => distPct(r.gammaFlip, r.price), render: (r) => lvl(r.gammaFlip, r.price) },
    { key: 'callWall', label: 'Call wall', align: 'r', value: (r) => distPct(r.callWall, r.price), render: (r) => lvl(r.callWall, r.price) }, { key: 'putWall', label: 'Put wall', align: 'r', value: (r) => distPct(r.putWall, r.price), render: (r) => lvl(r.putWall, r.price) },
    { key: 'near', label: 'Within 1.5% of', sort: false, render: (r) => (r.gexApproaching && r.gexApproaching.length ? r.gexApproaching.join(', ') : DASH) },
  ];
  return listView(host, data, { banner: h('div', { class: 'banner warn', role: 'note' }, 'Use walls as levels to watch, not levels to blindly trade. A wall can move, be overcome, or become irrelevant when the regime changes. GEX is an estimate that depends on assumptions and data timing.'),
    spec: [{ key: 'q', type: 'text', label: 'Ticker', ph: 'Ticker' }, { key: 'regime', type: 'select', label: 'Regime', options: [['Any regime', ''], ['Negative gamma', 'negative'], ['Positive gamma', 'positive']] }, { key: 'near', type: 'select', label: 'Proximity', options: [['Any distance', ''], ['Approaching a level', 'near']] }],
    defaults: { q: '', regime: '', near: '' }, source: (d) => (d.latest && d.latest.available !== false ? d.latest.rows.filter((r) => r.deep && (isNum(r.gammaFlip) || isNum(r.callWall) || isNum(r.netGamma))) : null),
    apply: (rows, f) => rows.filter((r) => (!f.q || r.ticker.includes(f.q)) && (!f.regime || r.regime === f.regime) && (!f.near || (r.gexApproaching && r.gexApproaching.length))), cols, label: 'GEX and gamma levels', sort: { key: 'netGamma', dir: -1 }, empty: 'Run a scan: GEX is computed for the most active tickers.' });
}
