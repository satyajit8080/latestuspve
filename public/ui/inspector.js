import { h, mount } from './dom.js';
import { dirChip, scoreCell, coverageMeter, gateBadges, freshBadge } from './parts.js';
import { signed, usd, times, int, compact } from '../app/fmt.js';
import { state } from '../app/store.js';
import { navigate, buildHash } from '../app/router.js';
export function createInspector(host) {
  let current = null, opener = null;
  const kv = (k, v) => h('div', {}, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v));
  function hide() { host.classList.remove('open'); host.setAttribute('aria-hidden', 'true'); mount(host); current = null; if (opener && opener.isConnected) opener.focus(); }
  function show(r) {
    current = r; opener = document.activeElement && document.activeElement.closest ? document.activeElement.closest('tr') : null;
    host.classList.add('open'); host.removeAttribute('aria-hidden');
    mount(host,
      h('div', { class: 'page-head' }, h('h2', {}, r.ticker), dirChip(r.dir, r.signal), h('span', { class: 'grow' }), h('button', { class: 'btn ghost', onclick: hide, aria: { label: 'Close preview' } }, 'Close')),
      h('div', { class: 'stack' },
        h('div', {}, scoreCell(r)), coverageMeter(r.coverage), gateBadges(r.gates, true),
        h('div', { class: 'kv' }, kv('Price', usd(r.price)), kv('Chg %', signed(r.changePct, 2, '%')), kv('vs VWAP', signed(r.vsVwapPct, 2, '%')), kv('RVOL', times(r.rvol)), kv('Net OI Δ', signed(r.oiNet, 0)), kv('IV rank', int(r.ivr)), kv('Sector', r.sector || '—'), kv('Tier', r.tier || '—')),
        h('div', {}, freshBadge(r.updatedAt, state.session.state)),
        h('button', { class: 'btn primary', onclick: () => navigate(buildHash('t', r.ticker)) }, 'Open tear sheet')));
  }
  host.setAttribute('aria-label', 'Row preview'); host.setAttribute('role', 'complementary');
  return { show, hide, current: () => current };
}
