// One table renderer for every list in the app: keyed rows, sticky header, aria-sort, roving tabindex,
// j/k/arrows/Enter/Space/Esc, value-tick flashes, FLIP rank movement, windowing above WINDOW rows.
import { h } from './dom.js';
import { diffRows } from './table-diff.js';
const WINDOW = 300, OVERSCAN = 8;
const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
export function createDataTable({ columns, rowKey, sortable = true, live = false, rowClass, onOpen, onSelect, onEscape, label = 'table', rowH = () => parseInt(getComputedStyle(document.documentElement).getPropertyValue('--row-h-current')) || 28 }) {
  let rows = [], sort = null, selected = null, prevRows = null, tickFields = columns.filter((c) => c.tick).map((c) => c.key);
  const wrap = h('div', { class: 'tablewrap', tabindex: '-1' });
  const thead = h('thead');
  const tbody = h('tbody');
  const table = h('table', { class: 'dt', role: 'grid', aria: { label, rowcount: 0 } }, thead, tbody);
  wrap.append(table);
  const rendered = new Map();                                   // key -> tr
  const hr = h('tr');
  const ths = columns.map((c) => {
    const th = h('th', { class: (c.align === 'r' ? 'r ' : '') + (c.sticky ? 'stickyL ' : '') + (c.hideM ? 'm-hide' : ''), scope: 'col', tabindex: sortable && c.sort !== false ? '0' : null, title: c.title }, c.label);
    if (sortable && c.sort !== false) {
      th.setAttribute('aria-sort', 'none');
      const go = () => setSort(c.key);
      th.addEventListener('click', go);
      th.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    }
    hr.append(th); return th;
  });
  thead.append(hr);
  function setSort(key, dir) {
    const col = columns.find((c) => c.key === key);
    const d = dir || (sort && sort.key === key ? -sort.dir : (col && col.firstDir) || -1);
    sort = { key, dir: d };
    ths.forEach((th, i) => { if (th.hasAttribute('aria-sort')) th.setAttribute('aria-sort', columns[i].key === key ? (d === 1 ? 'ascending' : 'descending') : 'none'); });
    draw(); wrap.dispatchEvent(new CustomEvent('sortchange', { detail: sort }));
  }
  const cmp = (a, b, col) => {
    const x = col.value ? col.value(a) : a[col.key], y = col.value ? col.value(b) : b[col.key];
    const nx = x == null || (typeof x === 'number' && !Number.isFinite(x)), ny = y == null || (typeof y === 'number' && !Number.isFinite(y));
    if (nx && ny) return 0; if (nx) return 1; if (ny) return -1;                // nulls always sink
    return typeof x === 'string' ? x.localeCompare(y) : x - y;
  };
  function sorted() {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key); if (!col) return rows;
    const out = rows.slice().sort((a, b) => { const x = cmp(a, b, col); return x === 0 || (col.nullsLast !== false && (col.value ? col.value(a) : a[col.key]) == null) ? x : x * sort.dir; });
    return out;
  }
  function fillCell(td, c, r) {
    const v = c.render(r);
    const key = typeof v === 'string' || typeof v === 'number' ? String(v) : null;
    if (key != null) { if (td.textContent !== key) td.textContent = key; return key; }
    if (v && v.nodeType) { td.replaceChildren(v); return v.textContent; }
    td.textContent = ''; return '';
  }
  function makeRow(r, k) {
    const tr = h('tr', { class: 'row', role: 'row', tabindex: '-1', dataset: { key: k } });
    tr.addEventListener('click', () => select(k, true)); tr.addEventListener('dblclick', () => onOpen && onOpen(r));
    columns.forEach((c) => { tr.append(h('td', { class: (c.align === 'r' ? 'r num ' : '') + (c.sticky ? 'stickyL ' : '') + (c.hideM ? 'm-hide' : ''), role: 'gridcell' })); });
    return tr;
  }
  function paintRow(tr, r, k, tickMap) {
    tr.dataset.dir = r.dir || ''; tr.className = 'row' + (rowClass ? ' ' + rowClass(r) : '') + (tr.classList.contains('isnew') ? ' isnew' : '');
    tr.setAttribute('aria-selected', selected === k ? 'true' : 'false');
    columns.forEach((c, i) => {
      const td = tr.children[i]; const before = td.textContent; const after = fillCell(td, c, r);
      if (live && tickMap && tickMap.has(k) && tickMap.get(k).includes(c.key) && before !== after && !reduce()) {
        const tone = c.tick ? c.tick(r, tickMap._old && tickMap._old.get(k)) : 'flat';
        td.classList.remove('tick-good', 'tick-bad', 'tick-flat'); void td.offsetWidth; td.classList.add('tick-' + (tone || 'flat'));
      }
    });
  }
  function draw(info) {
    const list = sorted(); const rh = rowH();
    const useWin = list.length > WINDOW;
    let from = 0, to = list.length;
    if (useWin) { from = Math.max(0, Math.floor(wrap.scrollTop / rh) - OVERSCAN); const vh = wrap.clientHeight || Math.round(innerHeight * 0.8); to = Math.min(list.length, from + Math.ceil(vh / rh) + OVERSCAN * 2 + 2); }
    table.setAttribute('aria-rowcount', list.length + 1);
    const before = reduce() || list.length > 50 || !live ? null : new Map([...rendered].map(([k, tr]) => [k, tr.getBoundingClientRect().top]));
    const tickMap = info && info.changed; if (tickMap && info.old) tickMap._old = info.old;
    const frag = [];
    if (useWin && from > 0) frag.push(h('tr', { class: 'spacer', aria: { hidden: 'true' } }, h('td', { colspan: columns.length, vars: { height: from * rh + 'px' } })));
    const keep = new Set();
    for (let i = from; i < to; i++) {
      const r = list[i], k = rowKey(r); keep.add(k);
      let tr = rendered.get(k); if (!tr) { tr = makeRow(r, k); rendered.set(k, tr); if (info && info.added && info.added.includes(k)) tr.classList.add('isnew'); }
      paintRow(tr, r, k, tickMap); frag.push(tr);
    }
    if (useWin && to < list.length) frag.push(h('tr', { class: 'spacer', aria: { hidden: 'true' } }, h('td', { colspan: columns.length, vars: { height: (list.length - to) * rh + 'px' } })));
    for (const [k, tr] of rendered) if (!keep.has(k)) { rendered.delete(k); }
    tbody.replaceChildren(...frag);
    for (const sp of tbody.querySelectorAll('.spacer td')) sp.style.height = sp.style.getPropertyValue('--height') || sp.style.height;
    if (before) for (const k of keep) { const tr = rendered.get(k), y0 = before.get(k); if (tr && y0 != null) { const dy = y0 - tr.getBoundingClientRect().top; if (dy) { tr.style.transition = 'none'; tr.style.transform = `translateY(${dy}px)`; requestAnimationFrame(() => { tr.style.transition = ''; tr.style.transform = ''; }); } } }
    if (info && info.added && info.added.length) setTimeout(() => { for (const k of info.added) rendered.get(k)?.classList.remove('isnew'); }, 3000);
  }
  function select(k, fromClick) {
    selected = k;
    for (const [kk, tr] of rendered) { tr.setAttribute('aria-selected', kk === k ? 'true' : 'false'); tr.tabIndex = kk === k ? 0 : -1; }
    const row = rows.find((r) => rowKey(r) === k); if (row && onSelect) onSelect(row, fromClick);
  }
  function move(delta) {
    const list = sorted(); if (!list.length) return;
    const i = Math.max(0, Math.min(list.length - 1, selected == null ? (delta > 0 ? 0 : list.length - 1) : list.findIndex((r) => rowKey(r) === selected) + delta));
    const k = rowKey(list[i]); select(k); if (list.length > WINDOW) { wrap.scrollTop = Math.max(0, i * rowH() - wrap.clientHeight / 2); draw(); }
    const tr = rendered.get(k); if (tr) { tr.focus({ preventScroll: true }); tr.scrollIntoView({ block: 'nearest' }); }
  }
  wrap.addEventListener('keydown', (e) => {
    if (e.target.closest('input,select,textarea')) return;
    if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter' && selected != null && !e.target.closest('th')) { e.preventDefault(); const r = rows.find((x) => rowKey(x) === selected); if (r && onOpen) onOpen(r); }   // preventDefault: focus moves into the dialog, so the same Enter must not also activate its Close button
    else if (e.key === ' ' && selected != null && !e.target.closest('th')) { e.preventDefault(); select(selected, true); }
    else if (e.key === 'Escape' && onEscape) onEscape();
  });
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => { if (rows.length > WINDOW) draw(); }).observe(wrap);
  let raf = 0; wrap.addEventListener('scroll', () => { if (rows.length > WINDOW && !raf) raf = requestAnimationFrame(() => { raf = 0; draw(); }); }, { passive: true });
  return {
    el: wrap, setSort, getSort: () => sort, getSelected: () => selected,
    select: (k) => select(k), count: () => rows.length,
    update(next, { sortState } = {}) {
      if (sortState && (!sort || sort.key !== sortState.key || sort.dir !== sortState.dir)) { sort = sortState; ths.forEach((th, i) => { if (th.hasAttribute('aria-sort')) th.setAttribute('aria-sort', columns[i].key === sort.key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'); }); }
      const info = live && prevRows ? diffRows(prevRows, next, rowKey, tickFields) : null;
      if (info) info.old = new Map(prevRows.map((r) => [rowKey(r), r]));
      prevRows = next; rows = next; draw(info);
    },
  };
}
