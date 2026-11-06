import { h, mount } from './dom.js';
import { openDialog, dialogOpen } from './dialog.js';
import { navigate, buildHash } from '../app/router.js';

export function openPalette(actions) {
  const input = h('input', { type: 'text', placeholder: 'Jump to a page or ticker, or run an action…', role: 'combobox', aria: { expanded: 'true', controls: 'pal-list', label: 'Command palette' }, autofocus: true, autocomplete: 'off' });
  const list = h('ul', { id: 'pal-list', role: 'listbox' });
  let items = [], sel = 0, dlg;
  const base = actions();
  function compute() {
    const q = input.value.trim(), up = q.toUpperCase();
    const out = base.filter((a) => !q || a.label.toLowerCase().includes(q.toLowerCase()));
    if (/^[A-Z][A-Z0-9.\-]{0,5}$/.test(up)) out.unshift({ label: `Open ticker ${up}`, hint: 'tear sheet', run: () => navigate(buildHash('t', up)) });
    items = out; sel = Math.min(sel, Math.max(0, items.length - 1)); draw();
  }
  function draw() {
    mount(list, items.map((a, i) => h('li', { role: 'option', aria: { selected: i === sel ? 'true' : 'false' }, onclick: () => run(i) }, h('span', {}, a.label), a.hint ? h('span', { class: 'k' }, a.hint) : null)));
    if (!items.length) mount(list, h('li', { class: 'dim' }, 'No matches'));
  }
  function run(i) { const a = items[i]; if (!a) return; dlg.close(); a.run(); }
  input.addEventListener('input', () => { sel = 0; compute(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); draw(); }
    else if (e.key === 'Enter') { e.preventDefault(); run(sel); }
  });
  dlg = openDialog({ title: null, className: 'palette', body: h('div', {}, input, list), labelledBy: 'pal-list' });
  dlg.el.setAttribute('aria-label', 'Command palette');
  compute();
}

export function installShortcuts({ palette, help, go, focusSearch }) {
  let chord = null, chordTimer = 0;
  document.addEventListener('keydown', (e) => {
    const typing = e.target.closest && e.target.closest('input,textarea,select,[contenteditable]');
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); if (!dialogOpen()) palette(); return; }
    if (typing || e.metaKey || e.ctrlKey || e.altKey || dialogOpen()) return;
    if (e.key === '/') { e.preventDefault(); focusSearch(); return; }
    if (e.key === '?') { e.preventDefault(); help(); return; }
    if (chord) { const map = { s: 'scan', t: 't', j: 'journal', l: 'lab', h: 'shadow', y: 'system' }; const v = map[e.key]; chord = null; clearTimeout(chordTimer); if (v) { e.preventDefault(); go(v); } return; }
    if (e.key === 'g') { chord = 'g'; chordTimer = setTimeout(() => { chord = null; }, 1200); }
  });
}
export function shortcutSheet() {
  const row = (k, t) => h('tr', {}, h('td', {}, h('kbd', {}, k)), h('td', { class: 'muted' }, t));
  openDialog({ title: 'Keyboard shortcuts', body: h('table', { class: 'ledger' }, h('tbody', {},
    row('g s', 'Scan'), row('g t', 'Ticker'), row('g j', 'Journal'), row('g l', 'Lab (ask the AI to test ideas)'), row('g h', 'Shadow (research)'), row('g y', 'System'),
    row('/', 'Focus ticker search'), row('Ctrl/⌘ K', 'Command palette'), row('j / k  ↑ / ↓', 'Move through table rows'), row('Enter', 'Open row'), row('Space', 'Preview row'), row('Esc', 'Close preview / dialog'), row('?', 'This sheet'))) });
}
