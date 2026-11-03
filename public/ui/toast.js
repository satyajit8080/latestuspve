import { h } from './dom.js';
let host;
export function toast(text, kind = '', ms = 4500) {
  host = host || document.body.appendChild(h('div', { class: 'toasts', role: 'status', aria: { live: 'polite' } }));
  while (host.children.length >= 3) host.firstChild.remove();
  const t = h('div', { class: 'toast ' + kind }, text); host.append(t); setTimeout(() => t.remove(), ms);
}
