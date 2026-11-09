import { h, mount } from '../../ui/dom.js';
import { api } from '../../app/api.js';
import { DASH, isNum } from '../../app/fmt.js';
import { lineChart } from '../../ui/charts.js';
import { toast } from '../../ui/toast.js';

const pct = (v, d = 2) => (isNum(v) ? `${(v * 100).toFixed(d)}%` : DASH);
const num = (v, d = 2) => (isNum(v) ? v.toFixed(d) : DASH);
const REG = { 'trend:up': 'Market trending up', 'trend:down': 'Market trending down', 'trend:flat': 'Market flat', 'vol:low': 'Low volatility', 'vol:mid': 'Mid volatility', 'vol:high': 'High volatility' };

export function renderBacktest(host) {
  let alive = true; let presets = []; const out = h('div', { class: 'stack' });
  const sel = h('select', { class: 'input', aria: { label: 'Strategy' } }); const note = h('p', { class: 'muted' });
  const cost = h('input', { class: 'input', type: 'number', min: '0', max: '200', value: '10', aria: { label: 'Cost per side (bps)' } });
  const topPct = h('input', { class: 'input', type: 'number', min: '2', max: '50', value: '10', aria: { label: 'Top and bottom percent' } });
  const horizon = h('select', { class: 'input', aria: { label: 'Holding days' } }, ...[1, 3, 5].map((v) => h('option', { value: String(v) }, `${v}-day hold`)));
  const side = h('select', { class: 'input', aria: { label: 'Side' } }, ...[['both', 'Long and short'], ['long', 'Long only'], ['short', 'Short only']].map(([v, l]) => h('option', { value: v }, l)));
  const oos = h('input', { type: 'checkbox', aria: { label: 'Open out-of-sample' } });
  const btn = h('button', { class: 'btn primary', onclick: run }, 'Run backtest');
  function pick() { const p = presets.find((q) => q.key === sel.value); if (!p) return; note.textContent = `${p.note}  Signal: ${p.signal}${p.filter ? `  ·  only when ${p.filter}` : ''}`; horizon.value = String(p.horizon); side.value = p.side; topPct.value = String(p.topPct); }
  sel.addEventListener('change', pick);
  const kv = (k, v) => h('div', {}, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v));
  const statsRow = (r) => (r && r.stats && r.stats.n ? h('div', { class: 'kv' }, kv('Trades (periods)', String(r.stats.n)), kv('Win rate', pct(r.stats.winRate, 1)), kv('Avg return / trade', pct(r.stats.avgReturn)), kv('Profit factor', num(r.stats.profitFactor)), kv('Expectancy', pct(r.stats.expectancy)), kv('Max drawdown', pct(r.stats.maxDrawdown, 1)), kv('Sharpe (annualised)', num(r.stats.sharpe)), kv('Total return', pct(r.stats.totalReturn, 1)), kv('Avg before costs', pct(r.grossAvg))) : h('p', { class: 'muted' }, 'Not enough data in this block.'));
  const regimes = (r) => { const e = Object.entries((r && r.regimes) || {}).filter(([, v]) => v.n); return e.length ? h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ...['Regime', 'Periods', 'Win rate', 'Avg return', 'Sharpe'].map((c) => h('th', {}, c)))), h('tbody', {}, ...e.map(([k, v]) => h('tr', {}, h('td', {}, REG[k] || k), h('td', { class: 'num' }, String(v.n)), h('td', { class: 'num' }, pct(v.winRate, 1)), h('td', { class: 'num' }, pct(v.avgReturn)), h('td', { class: 'num' }, num(v.sharpe)))))) : null; };
  const block = (title, r, state) => h('section', { class: 'panel' }, h('header', {}, h('h2', {}, title), state ? h('span', { class: 'chip neutral' }, state) : null), h('div', { class: 'body stack' }, statsRow(r),
    r && r.curve && r.curve.length > 2 ? lineChart({ series: [{ points: r.curve.map((v, i) => [i, (v - 1) * 100]), cls: 'c-info' }], yFmt: (v) => `${v.toFixed(0)}%`, label: `${title} equity curve`, h: 160 }) : null, regimes(r)));
  function show(d) {
    mount(out, h('div', { class: 'stack' }, h('p', { class: 'dim expr' }, `${d.strategy.name}  ·  signal ${d.strategy.signal}${d.strategy.filter ? `  ·  only when ${d.strategy.filter}` : ''}  ·  ${d.strategy.horizon}-day hold  ·  ${d.strategy.side}  ·  top/bottom ${d.strategy.topPct}%  ·  ${d.strategy.costBps} bps per side`),
      block('Train', d.train), block('Validation', d.validation),
      d.oos ? block('Out-of-sample', d.oos, 'opened (once)') : h('section', { class: 'panel' }, h('header', {}, h('h2', {}, 'Out-of-sample'), h('span', { class: 'chip neutral' }, d.oosState)), h('div', { class: 'body' }, h('p', { class: 'muted' }, d.oosState === 'refused' ? 'Not opened (see notes).' : 'Sealed. It can be opened once per strategy.'))),
      h('ul', { class: 'muted' }, ...d.notes.map((n) => h('li', {}, n)))));
  }
  async function run() {
    if (oos.checked && !window.confirm('Open out-of-sample for this strategy? You get exactly one look; changing the strategy afterwards makes the result unreliable.')) return;
    btn.disabled = true; mount(out, h('p', { class: 'muted' }, 'Running…'));
    try {
      const base = presets.find((q) => q.key === sel.value);
      const res = await api('/api/intel/backtest/run', { method: 'POST', body: { preset: base && base.key, strategy: { horizon: Number(horizon.value), side: side.value, topPct: Number(topPct.value), costBps: Number(cost.value) }, confirmOos: oos.checked } });
      const r = res.data || {}; if (!alive) return; if (!res.ok || !r.ok) throw new Error(r.error || 'Backtest failed (is the server restarted?)'); show(r);
    } catch (e) { if (alive) { mount(out, h('div', { class: 'banner err', role: 'alert' }, e.message)); toast(e.message); } } finally { btn.disabled = false; }
  }
  const form = h('section', { class: 'panel' }, h('header', {}, h('h2', {}, 'Strategy Backtesting')), h('div', { class: 'body stack' },
    h('div', { class: 'banner warn', role: 'note' }, 'Research tool: rules are tested on daily bars from the 2-year backfill (flow, open interest, price, volume; gamma where available). Signals use data up to the close, trades are held without overlap, costs are charged. Past results do not predict future results; this is not advice.'),
    h('div', { class: 'filters' }, sel, horizon, side, h('label', {}, 'Top/bottom % ', topPct), h('label', {}, 'Cost bps/side ', cost)), note,
    h('label', {}, oos, ' Open out-of-sample (one look only)'), h('div', {}, btn)));
  mount(host, h('div', { class: 'stack' }, form, out));
  api('/api/intel/backtest/presets').then((res) => { const r = res.data || {}; if (!alive) return; if (!res.ok || !r.ok) { const e = new Error(r.error || 'Backtest API not found (restart the server after git pull)'); e.code = r.code; throw e; } presets = r.presets; sel.replaceChildren(...presets.map((p) => h('option', { value: p.key }, p.name))); pick(); })
    .catch((e) => { if (alive) mount(out, h('div', { class: 'banner err', role: 'alert' }, e.code === 'NO_DATA' || /not built/.test(e.message) ? 'Lab dataset not built yet: run node scripts/uw-lab.mjs features on the server.' : e.message)); });
  return { destroy() { alive = false; } };
}
