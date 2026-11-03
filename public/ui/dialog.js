import { h } from './dom.js';
const FOCUSABLE = 'a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea,[tabindex]:not([tabindex="-1"])';
let stack = [];
export function openDialog({ title, body, wide, onClose, className = '', labelledBy = 'dlg-title' }) {
  const prevFocus = document.activeElement;
  const closeBtn = h('button', { class: 'btn ghost', aria: { label: 'Close' }, onclick: () => close() }, 'Close');
  const dlg = h('div', { class: 'dialog ' + className, role: 'dialog', aria: { modal: 'true', labelledby: labelledBy }, tabindex: '-1' },
    title ? h('header', {}, h('h2', { id: labelledBy }, title), h('span', { style: null, class: 'grow' }), closeBtn) : null,
    h('div', { class: 'body' }, body));
  const ov = h('div', { class: 'overlay' }, dlg);
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
  function key(e) {
    if (stack[stack.length - 1] !== api) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Tab') { const f = [...dlg.querySelectorAll(FOCUSABLE)]; if (!f.length) { e.preventDefault(); return; } const a = f[0], z = f[f.length - 1]; if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); } else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); } }
  }
  function close() { document.removeEventListener('keydown', key, true); ov.remove(); stack = stack.filter((x) => x !== api); if (prevFocus && prevFocus.isConnected) prevFocus.focus(); onClose && onClose(); }
  const api = { close, el: dlg };
  stack.push(api); document.addEventListener('keydown', key, true); document.body.append(ov);
  (dlg.querySelector('[autofocus]') || dlg.querySelector(FOCUSABLE) || dlg).focus();
  return api;
}
export const dialogOpen = () => stack.length > 0;
