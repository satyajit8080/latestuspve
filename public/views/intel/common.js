import { h } from '../../ui/dom.js';
import { isNum, DASH, pct, compact, signed, etStamp } from '../../app/fmt.js';

export const stateChip = (r) => h('span', { class: `chip ${r.state === 'BULL' ? 'bull' : r.state === 'BEAR' ? 'bear' : r.state === 'NO_TRADE' ? 'gate' : 'neutral'}`, title: r.reasons && r.reasons.length ? r.reasons.join('; ') : null }, r.state === 'BULL' ? '▲ BULL' : r.state === 'BEAR' ? '▼ BEAR' : r.state === 'NO_TRADE' ? 'NO TRADE' : 'screened');
export const MODE_HELP = { LIVE: 'Market is open and this snapshot is under 20 minutes old.', DELAYED: 'Market is open but this snapshot is older than 20 minutes.', CLOSED: 'Market closed: showing the last session.', HISTORICAL: 'A stored snapshot from the past, not current data.' };
export const modeChip = (mode) => h('span', { class: `chip ${mode === 'LIVE' ? 'ok' : mode === 'DELAYED' ? 'gate' : mode === 'HISTORICAL' ? 'shadow' : 'neutral'}`, title: MODE_HELP[mode] || '' }, mode || 'NO DATA');
export const usdC = (v) => (isNum(v) ? `$${compact(v)}` : DASH);
export const px = (v) => (isNum(v) ? v.toFixed(2) : DASH);
export const sgn = (v, d = 0) => (isNum(v) ? signed(v * 100, d, '%') : DASH);
export const tone = (v) => (isNum(v) ? (v > 0 ? 'bull' : v < 0 ? 'bear' : '') : 'dim');
export const distPct = (level, price) => (isNum(level) && isNum(price) && price > 0 ? (level - price) / price : null);
export const num0 = (v) => (isNum(v) ? Math.round(v).toLocaleString('en-US') : DASH);
export const etTime = (ms) => etStamp(ms);

// FILTERS: spec = [{ key, label, type:'text'|'select'|'number', options:[[label,value]], ph, w }] ; f is mutated and onChange() is called
export function filterBar(spec, f, onChange) {
  let t = 0; const deb = () => { clearTimeout(t); t = setTimeout(onChange, 150); };
  return h('div', { class: 'filterbar', role: 'search' }, spec.map((c) => c.type === 'select'
    ? h('select', { class: 'select', aria: { label: c.label }, onchange: (e) => { f[c.key] = e.target.value; onChange(); } }, c.options.map(([l, v]) => h('option', { value: v, selected: String(f[c.key]) === String(v) }, l)))
    : h('input', { class: 'input', type: c.type === 'number' ? 'number' : 'text', placeholder: c.ph || c.label, value: f[c.key] ?? '', aria: { label: c.label }, min: c.type === 'number' ? '0' : null, oninput: (e) => { f[c.key] = c.type === 'text' ? e.target.value.toUpperCase() : e.target.value; deb(); } })));
}
export const numOr = (v) => (v === '' || v == null || !Number.isFinite(+v) ? null : +v);
export function interpretFlow(a) {
  if (a.multileg) return 'Part of a multi-leg package: reconstruct all legs before inferring direction.';
  const c = a.right === 'call'; if (a.side === 'ask') return c ? 'Possible buyer-initiated call: direction may be bullish.' : 'Possible buyer-initiated put: direction may be bearish (or a hedge).';
  if (a.side === 'bid') return c ? 'Possible seller-initiated call: bearish or premium selling.' : 'Possible seller-initiated put: bullish or premium selling.'; return 'Direction unclear from the print alone.';
}
export function interpretPositioning(r) {
  const out = []; if (isNum(r.oiImbalance)) out.push(r.oiImbalance > 0.25 ? 'Call open interest grew more than put open interest (published after the prior session).' : r.oiImbalance < -0.25 ? 'Put open interest grew more than call open interest (published after the prior session).' : 'Open-interest change is balanced.');
  if (isNum(r.volOiHits) && r.volOiHits > 0) out.push(`${r.volOiHits} contract(s) traded more than their open interest: a screening clue, not proof that positions were opened.`);
  if (isNum(r.openingShare)) out.push(r.openingShare >= 0.6 ? 'Most single-leg flow is flagged as opening.' : r.openingShare < 0.3 ? 'Little flow is flagged as opening: it may be closing or hedging.' : 'Mixed opening and closing flow.');
  if (isNum(r.multiLegShare) && r.multiLegShare > 0.4) out.push('A large share is multi-leg: spreads and hedges can look directional.'); return out.join(' ') || 'Not enough data to interpret.';
}
export function interpretVol(r) {
  const out = []; if (isNum(r.ivRank)) out.push(r.ivRank > 80 ? 'IV rank is high: long options are expensive and a volatility drop can erase a correct direction.' : r.ivRank < 25 ? 'IV rank is low (low IV does not by itself make options cheap).' : 'IV rank is mid-range.');
  if (isNum(r.iv) && isNum(r.rv20) && r.rv20 > 0) out.push(r.iv / r.rv20 > 1.3 ? 'Implied volatility is well above realized: premium is priced rich.' : r.iv / r.rv20 < 0.9 ? 'Implied volatility is below realized: the market may be pricing less movement than recently occurred.' : 'Implied and realized volatility are similar.');
  if (isNum(r.termSlope)) out.push(r.termSlope < -0.02 ? 'Inverted term structure: near-term expiries are priced above later ones (an event or stress premium).' : r.termSlope > 0.03 ? 'Upward-sloping term structure.' : 'Flat term structure.'); return out.join(' ') || 'No volatility data.';
}
export function table(cols, rows, { empty = 'No rows', onOpen = null, cls = 'dt' } = {}) {
  if (!rows.length) return h('p', { class: 'muted' }, empty);
  return h('table', { class: cls }, h('thead', {}, h('tr', {}, cols.map((c) => h('th', { class: c.r ? 'r' : '' }, c.label)))), h('tbody', {}, rows.map((r) => h('tr', { class: 'row', onclick: onOpen ? () => onOpen(r) : null }, cols.map((c) => h('td', { class: c.r ? 'r num' : '' }, c.render(r)))))));
}
