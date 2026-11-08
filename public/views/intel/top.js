import { h, mount } from '../../ui/dom.js';
import { isNum, DASH, pct } from '../../app/fmt.js';
import { emptyState } from '../../ui/parts.js';
import { stateChip, usdC, px, sgn, tone, etTime, numOr } from './common.js';
import { openTicker } from './list-view.js';

const kv = (k, v) => h('div', {}, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v));
export function card(r) {
  const lv = (x) => (x && isNum(x.price) ? `${px(x.price)} · ${x.basis}` : DASH);
  return h('article', { class: `oppcard ${r.state === 'BULL' ? 'bull' : 'bear'}` },
    h('h3', {}, h('strong', {}, r.ticker), h('span', { class: 'muted' }, r.name || ''), stateChip(r), h('span', { class: 'num' }, `Score ${r.score}`), h('span', { class: 'hint' }, '·'), h('span', { class: `num ${tone(r.chgPct)}` }, `$${px(r.price)} (${sgn(r.chgPct, 1)})`)),
    h('div', { class: 'kv' }, kv('Flow imbalance', h('span', { class: tone(r.imbalance) }, sgn(r.imbalance))), kv('Call / put premium', `${usdC(r.callPremium)} / ${usdC(r.putPremium)}`), kv('Unusual flow', `${r.unusualCount ?? 0} unusual · ${isNum(r.openingShare) ? pct(r.openingShare) : DASH} opening · ${isNum(r.sweepShare) ? pct(r.sweepShare) : DASH} sweeps`),
      kv('GEX positioning', r.regime ? `${r.regime === 'negative' ? 'Negative' : 'Positive'} gamma${isNum(r.gammaFlip) ? ` · flip ${px(r.gammaFlip)}` : ''}` : DASH), kv('IV rank', isNum(r.ivRank) ? String(Math.round(r.ivRank)) : DASH), kv('Relative volume', isNum(r.rvol) ? `${r.rvol.toFixed(1)}×` : DASH),
      kv('Support', lv(r.support)), kv('Resistance', lv(r.resistance)), kv('Reference level', lv(r.target1)), kv('Invalidation', r.invalidation ? `${px(r.invalidation.price)} · ${r.invalidation.basis}` : DASH), kv('Risk / reward', isNum(r.riskReward) ? r.riskReward.toFixed(2) : DASH), kv('Signal time', etTime(r.signalAt))),
    h('ul', {}, (r.why || []).map((w) => h('li', {}, w))), h('p', { class: 'hint' }, 'Reference levels are areas to watch, not price forecasts. Not a recommendation.'),
    h('div', { class: 'filterbar' }, h('button', { class: 'btn primary', onclick: () => openTicker(r.ticker) }, 'Open analysis')));
}
export function renderTop(host, data) {
  const f = { min: '55' }; const body = h('div');
  const minIn = h('input', { class: 'input', type: 'number', value: f.min, min: '0', max: '100', aria: { label: 'Minimum score' }, oninput: (e) => { f.min = e.target.value; draw(); } });
  function draw() {
    const rows = data.latest && data.latest.available !== false ? data.latest.rows.filter((r) => r.deep) : null;
    if (!rows) return mount(body, emptyState('No scan yet', 'Press “Run scan” to rank opportunities.'));
    const min = numOr(f.min) ?? 0; const pick = (st) => rows.filter((r) => r.state === st && r.score >= min).sort((a, b) => b.score - a.score); const bull = pick('BULL'), bear = pick('BEAR'), none = rows.filter((r) => r.state === 'NO_TRADE').sort((a, b) => b.score - a.score);
    mount(body, h('div', { class: 'oppcols' }, h('section', { class: 'opp' }, h('h2', {}, `Bullish evidence (${bull.length})`), bull.length ? bull.map(card) : h('p', { class: 'muted' }, 'No bullish setup passes the gates right now. Staying out is a valid outcome.')),
      h('section', { class: 'opp' }, h('h2', {}, `Bearish evidence (${bear.length})`), bear.length ? bear.map(card) : h('p', { class: 'muted' }, 'No bearish setup passes the gates right now. Staying out is a valid outcome.'))),
      h('details', { class: 'panel' }, h('summary', {}, h('strong', {}, `No trade (${none.length})`), h('span', { class: 'chip' }, 'filtered out')), h('div', { class: 'body' }, none.length ? h('table', { class: 'dt' }, h('thead', {}, h('tr', {}, ['Ticker', 'Best score', 'Why it was filtered out'].map((x) => h('th', {}, x)))), h('tbody', {}, none.map((r) => h('tr', { class: 'row', onclick: () => openTicker(r.ticker) }, h('td', {}, h('strong', {}, r.ticker)), h('td', { class: 'num' }, String(r.score)), h('td', {}, (r.reasons || []).join('; ') || DASH))))) : h('p', { class: 'muted' }, 'Nothing filtered out.'))));
  }
  mount(host, h('div', { class: 'stack' }, h('div', { class: 'banner shadow', role: 'note' }, 'Ranked by transparent evidence scores (prior weights, not yet validated). The engine may return NO TRADE. Nothing here is a guaranteed outcome or an automatic buy/sell recommendation.'),
    h('div', { class: 'filterbar' }, h('label', { class: 'muted', for: 'min-score' }, 'Minimum score'), minIn), body)); minIn.id = 'min-score'; draw(); return { destroy: data.subscribe(draw) };
}
