import { h } from '../../ui/dom.js';
import { isNum, DASH, pct } from '../../app/fmt.js';
import { listView } from './list-view.js';
import { usdC, px, numOr, interpretFlow, etTime } from './common.js';

const spec = [{ key: 'q', type: 'text', label: 'Ticker', ph: 'Ticker' }, { key: 'right', type: 'select', label: 'Call or put', options: [['Calls and puts', ''], ['Calls', 'call'], ['Puts', 'put']] }, { key: 'side', type: 'select', label: 'Execution side', options: [['Any side', ''], ['At the ask', 'ask'], ['At the bid', 'bid']] },
  { key: 'min', type: 'number', label: 'Minimum premium ($k)', ph: 'Min premium $k' }, { key: 'maxDte', type: 'number', label: 'Maximum days to expiry', ph: 'DTE ≤' }, { key: 'flag', type: 'select', label: 'Flags', options: [['Any flags', ''], ['Sweeps only', 'sweep'], ['Opening only', 'opening'], ['Single-leg only', 'single'], ['Multi-leg only', 'multi']] }];
const dteOf = (a) => (a.expiry && a.ts ? Math.round((Date.parse(`${a.expiry}T12:00:00Z`) - Date.parse(`${new Date(a.ts).toISOString().slice(0, 10)}T12:00:00Z`)) / 86400000) : null);
export function applyFlow(rows, f) {
  const min = numOr(f.min), dte = numOr(f.maxDte);
  return rows.filter((a) => (!f.q || a.ticker.includes(f.q)) && (!f.right || a.right === f.right) && (!f.side || a.side === f.side) && (min == null || a.premium >= min * 1000) && (dte == null || (dteOf(a) != null && dteOf(a) <= dte))
    && (!f.flag || (f.flag === 'sweep' ? a.sweep : f.flag === 'opening' ? a.opening : f.flag === 'single' ? !a.multileg : a.multileg)));
}
export function renderFlow(host, data) {
  const cols = [
    { key: 'ts', label: 'Time (ET)', firstDir: -1, render: (a) => etTime(a.ts) }, { key: 'ticker', label: 'Ticker', sticky: true, firstDir: 1, render: (a) => h('strong', {}, a.ticker) },
    { key: 'right', label: 'C/P', render: (a) => h('span', { class: a.right === 'call' ? 'bull' : 'bear' }, a.right === 'call' ? 'CALL' : 'PUT') }, { key: 'strike', label: 'Strike', align: 'r', render: (a) => px(a.strike) },
    { key: 'expiry', label: 'Expiry (DTE)', render: (a) => `${a.expiry || DASH}${dteOf(a) != null ? ` (${dteOf(a)})` : ''}` }, { key: 'premium', label: 'Premium', align: 'r', render: (a) => usdC(a.premium) },
    { key: 'side', label: 'Side', render: (a) => (a.side === 'ask' ? 'at ask' : a.side === 'bid' ? 'at bid' : a.side === 'mid' ? 'mid' : DASH) }, { key: 'volOi', label: 'Vol/OI', align: 'r', render: (a) => (isNum(a.volOi) ? a.volOi.toFixed(1) : DASH) },
    { key: 'flags', label: 'Flags', sort: false, render: (a) => [a.sweep ? 'sweep' : null, a.opening ? 'opening' : null, a.multileg ? 'multi-leg' : null, a.floor ? 'floor' : null].filter(Boolean).join(' · ') || DASH }, { key: 'spot', label: 'Spot', align: 'r', hideM: true, render: (a) => px(a.spot) },
    { key: 'read', label: 'How to read it', sort: false, hideM: true, render: (a) => interpretFlow(a) },
  ];
  return listView(host, data, { banner: h('div', { class: 'banner warn', role: 'note' }, h('span', {}, 'Critical caveat: a call bought to open, a call sold to close, a covered-call sale and a call-spread leg can all look alike. Never translate “call at ask” directly into “bullish whale bet”. Inspect multi-leg activity and compare later open-interest changes.')),
    spec, defaults: { q: '', right: '', side: '', min: '', maxDte: '', flag: '' }, source: (d) => (d.flow && d.flow.available ? d.flow.alerts : (d.flow ? [] : null)), apply: applyFlow, cols, rowKey: (a) => `${a.ticker}|${a.ts}|${a.strike}|${a.right}|${a.premium}`, label: 'Unusual options flow', sort: { key: 'premium', dir: -1 }, needs: () => data.loadFlow() });
}
