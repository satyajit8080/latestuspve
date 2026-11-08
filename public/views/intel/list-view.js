import { h, mount } from '../../ui/dom.js';
import { createDataTable } from '../../ui/data-table.js';
import { emptyState } from '../../ui/parts.js';
import { filterBar } from './common.js';

export const openTicker = (t) => { location.hash = `#/intel/t/${encodeURIComponent(t)}`; };
// A filterable, sortable list. source(data) -> array | null (not loaded yet).
export function listView(host, data, { banner, spec, defaults, source, apply, cols, rowKey = (r) => r.ticker, label, sort, empty = 'Press “Run scan” to populate this page.', onOpen = (r) => openTicker(r.ticker), needs = null }) {
  const f = { ...defaults }; const table = createDataTable({ columns: cols, rowKey, label, onOpen }); const body = h('div'); const count = h('span', { class: 'count num', role: 'status', aria: { live: 'polite' } });
  function draw() {
    const all = source(data); if (all == null) { mount(body, emptyState('No data yet', empty)); count.textContent = ''; return; }
    const rows = apply(all, f); count.textContent = `${rows.length} of ${all.length}`;
    if (!all.length) mount(body, emptyState('Nothing to show', empty)); else if (!rows.length) mount(body, emptyState('No rows match the filters', 'Loosen a filter.')); else { mount(body, table.el); table.update(rows, { sortState: sort }); }
  }
  mount(host, h('div', { class: 'stack' }, banner || null, h('div', { class: 'filterbar' }, filterBar(spec, f, draw), count), body));
  const unsub = data.subscribe(draw); if (needs) needs(); draw(); return { destroy: unsub };
}
