import { h } from '../../ui/dom.js';
import { isNum, DASH, pct } from '../../app/fmt.js';
import { listView } from './list-view.js';
import { stateChip, tone, sgn, numOr, interpretVol } from './common.js';

export function renderVolatility(host, data) {
  const cols = [
    { key: 'ticker', label: 'Ticker', sticky: true, firstDir: 1, render: (r) => h('strong', {}, r.ticker) }, { key: 'state', label: 'Signal', value: (r) => (r.state === 'BULL' ? 2 : r.state === 'BEAR' ? -2 : 0), render: stateChip },
    { key: 'iv', label: 'IV (~30d)', align: 'r', render: (r) => (isNum(r.iv) ? pct(r.iv, 0) : DASH) }, { key: 'ivRank', label: 'IV rank', align: 'r', render: (r) => (isNum(r.ivRank) ? String(Math.round(r.ivRank)) : DASH) },
    { key: 'rv20', label: 'Realized (20d)', align: 'r', title: 'Computed from daily closes', render: (r) => (isNum(r.rv20) ? pct(r.rv20, 0) : DASH) }, { key: 'ivrv', label: 'IV / RV', align: 'r', value: (r) => (isNum(r.iv) && isNum(r.rv20) && r.rv20 > 0 ? r.iv / r.rv20 : null), render: (r) => (isNum(r.iv) && isNum(r.rv20) && r.rv20 > 0 ? (r.iv / r.rv20).toFixed(2) : DASH) },
    { key: 'termSlope', label: 'Term slope', align: 'r', title: 'Back IV minus front IV (vol points)', render: (r) => h('span', { class: tone(r.termSlope) }, isNum(r.termSlope) ? sgn(r.termSlope, 1) : DASH) }, { key: 'impliedMovePct', label: 'Implied move', align: 'r', render: (r) => (isNum(r.impliedMovePct) ? pct(r.impliedMovePct, 1) : DASH) },
    { key: 'rr25', label: '25Δ risk reversal', align: 'r', render: (r) => (isNum(r.rr25) ? sgn(r.rr25, 1) : DASH) }, { key: 'daysToEarnings', label: 'Earn. (d)', align: 'r', render: (r) => (isNum(r.daysToEarnings) ? String(r.daysToEarnings) : DASH) }, { key: 'read', label: 'Interpretation', sort: false, hideM: true, render: interpretVol },
  ];
  return listView(host, data, { banner: h('div', { class: 'banner warn', role: 'note' }, 'A directional read can be right and still lose when the option is overpriced, illiquid, short-dated or exposed to a volatility crush. Contract selection is a separate step from direction.'),
    spec: [{ key: 'q', type: 'text', label: 'Ticker', ph: 'Ticker' }, { key: 'ivMin', type: 'number', label: 'Minimum IV rank', ph: 'IV rank ≥' }, { key: 'ivMax', type: 'number', label: 'Maximum IV rank', ph: 'IV rank ≤' }, { key: 'earn', type: 'number', label: 'Earnings within days', ph: 'Earnings ≤ d' }, { key: 'rich', type: 'select', label: 'IV vs realized', options: [['Any IV/RV', ''], ['IV above realized', 'rich'], ['IV below realized', 'cheap']] }],
    defaults: { q: '', ivMin: '', ivMax: '', earn: '', rich: '' }, source: (d) => (d.latest && d.latest.available !== false ? d.latest.rows.filter((r) => r.deep && (isNum(r.ivRank) || isNum(r.iv))) : null),
    apply: (rows, f) => { const a = numOr(f.ivMin), b = numOr(f.ivMax), e = numOr(f.earn); return rows.filter((r) => (!f.q || r.ticker.includes(f.q)) && (a == null || (isNum(r.ivRank) && r.ivRank >= a)) && (b == null || (isNum(r.ivRank) && r.ivRank <= b)) && (e == null || (isNum(r.daysToEarnings) && r.daysToEarnings <= e)) && (!f.rich || (isNum(r.iv) && isNum(r.rv20) && (f.rich === 'rich' ? r.iv > r.rv20 : r.iv < r.rv20)))); },
    cols, label: 'Volatility intelligence', sort: { key: 'ivRank', dir: -1 }, empty: 'Run a scan: volatility is analysed for the most active tickers.' });
}
