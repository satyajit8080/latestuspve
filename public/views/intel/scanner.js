import { h } from '../../ui/dom.js';
import { isNum, DASH, pct } from '../../app/fmt.js';
import { listView } from './list-view.js';
import { stateChip, usdC, px, sgn, tone, numOr } from './common.js';

const spec = [
  { key: 'q', type: 'text', label: 'Ticker', ph: 'Ticker', w: 90 }, { key: 'dir', type: 'select', label: 'Direction', options: [['Any signal', ''], ['Bullish', 'BULL'], ['Bearish', 'BEAR'], ['No trade', 'NO_TRADE'], ['Analysed in depth', 'deep'], ['Screened only', 'shallow']] },
  { key: 'minPrem', type: 'number', label: 'Minimum premium ($k)', ph: 'Min premium $k' }, { key: 'minCap', type: 'number', label: 'Minimum market cap ($B)', ph: 'Min cap $B' }, { key: 'ivMin', type: 'number', label: 'Minimum IV rank', ph: 'IV rank ≥' }, { key: 'ivMax', type: 'number', label: 'Maximum IV rank', ph: 'IV rank ≤' },
  { key: 'maxDte', type: 'number', label: 'Maximum average days to expiry', ph: 'Avg DTE ≤' }, { key: 'minRvol', type: 'number', label: 'Minimum relative volume', ph: 'RVOL ≥' },
];
export function applyScan(rows, f) {
  const n = { prem: numOr(f.minPrem), cap: numOr(f.minCap), ivMin: numOr(f.ivMin), ivMax: numOr(f.ivMax), dte: numOr(f.maxDte), rv: numOr(f.minRvol) };
  return rows.filter((r) => (!f.q || r.ticker.includes(f.q)) && (!f.dir || (f.dir === 'deep' ? r.deep : f.dir === 'shallow' ? !r.deep : r.state === f.dir))
    && (n.prem == null || (isNum(r.totalPremium) && r.totalPremium >= n.prem * 1000)) && (n.cap == null || (isNum(r.marketCap) && r.marketCap >= n.cap * 1e9)) && (n.ivMin == null || (isNum(r.ivRank) && r.ivRank >= n.ivMin)) && (n.ivMax == null || (isNum(r.ivRank) && r.ivRank <= n.ivMax))
    && (n.dte == null || (isNum(r.dte) && r.dte <= n.dte)) && (n.rv == null || (isNum(r.rvol) && r.rvol >= n.rv)));
}
export const scannerCols = [
  { key: 'ticker', label: 'Ticker', sticky: true, firstDir: 1, render: (r) => h('strong', {}, r.ticker) },
  { key: 'state', label: 'Signal', value: (r) => (r.deep ? (r.state === 'BULL' ? 2 : r.state === 'BEAR' ? -2 : 0) : null), render: stateChip },
  { key: 'score', label: 'Score', align: 'r', value: (r) => (r.deep ? r.score : null), render: (r) => (r.deep ? String(r.score) : DASH) },
  { key: 'bb', label: 'Bull / Bear', align: 'r', hideM: true, value: (r) => (r.deep ? r.bullScore - r.bearScore : null), render: (r) => (r.deep ? `${r.bullScore} / ${r.bearScore}` : DASH) },
  { key: 'price', label: 'Price', align: 'r', render: (r) => px(r.price) }, { key: 'chgPct', label: 'Chg', align: 'r', render: (r) => h('span', { class: tone(r.chgPct) }, sgn(r.chgPct, 1)) },
  { key: 'totalPremium', label: 'Premium', align: 'r', render: (r) => usdC(r.totalPremium) }, { key: 'imbalance', label: 'Flow imbalance', align: 'r', title: 'Aggressor-signed single-leg premium: +100% all bullish-leaning, −100% all bearish-leaning', render: (r) => h('span', { class: tone(r.imbalance) }, sgn(r.imbalance)) },
  { key: 'openingShare', label: 'Opening', align: 'r', hideM: true, render: (r) => (isNum(r.openingShare) ? pct(r.openingShare) : DASH) }, { key: 'sweepShare', label: 'Sweeps', align: 'r', hideM: true, render: (r) => (isNum(r.sweepShare) ? pct(r.sweepShare) : DASH) },
  { key: 'unusualCount', label: 'Unusual', align: 'r', hideM: true, title: 'Single-leg opening alerts with volume above open interest', render: (r) => (isNum(r.unusualCount) ? String(r.unusualCount) : DASH) },
  { key: 'ivRank', label: 'IV rank', align: 'r', render: (r) => (isNum(r.ivRank) ? String(Math.round(r.ivRank)) : DASH) },
  { key: 'regime', label: 'Gamma', value: (r) => (r.regime === 'negative' ? -1 : r.regime === 'positive' ? 1 : null), render: (r) => (r.regime ? h('span', { title: r.gexApproaching && r.gexApproaching.length ? `Near: ${r.gexApproaching.join(', ')}` : null }, `${r.regime === 'negative' ? '−γ' : '+γ'}${r.gexApproaching && r.gexApproaching.length ? ' ◎' : ''}`) : DASH) },
  { key: 'rvol', label: 'RVOL', align: 'r', hideM: true, render: (r) => (isNum(r.rvol) ? `${r.rvol.toFixed(1)}×` : DASH) }, { key: 'dte', label: 'Avg DTE', align: 'r', hideM: true, render: (r) => (isNum(r.dte) ? String(Math.round(r.dte)) : DASH) },
  { key: 'daysToEarnings', label: 'Earn. (d)', align: 'r', hideM: true, render: (r) => (isNum(r.daysToEarnings) ? String(r.daysToEarnings) : DASH) },
];
export function renderScanner(host, data) {
  return listView(host, data, { banner: h('div', { class: 'banner shadow', role: 'note' }, 'Every ticker is screened on its option flow; the most active are analysed in depth and scored. Scores summarize evidence with prior weights that are not yet validated. They are not predictions.'),
    spec, defaults: { q: '', dir: '', minPrem: '', minCap: '', ivMin: '', ivMax: '', maxDte: '', minRvol: '' }, source: (d) => (d.latest && d.latest.available !== false ? d.latest.rows.filter((r) => !r.error) : null), apply: applyScan, cols: scannerCols, label: 'Market scanner', sort: { key: 'score', dir: -1 } });
}
