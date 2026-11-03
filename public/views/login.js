import { h, mount } from '../ui/dom.js';
import { api } from '../app/api.js';
import { countdown } from '../app/fmt.js';

export function renderLogin(root, onOk) {
  const pw = h('input', { class: 'input', type: 'password', id: 'pw', name: 'password', autocomplete: 'current-password', required: true, autofocus: true });
  const toggle = h('button', { class: 'btn', type: 'button', aria: { pressed: 'false', label: 'Show password' }, onclick: () => { const show = pw.type === 'password'; pw.type = show ? 'text' : 'password'; toggle.setAttribute('aria-pressed', String(show)); toggle.textContent = show ? 'Hide' : 'Show'; } }, 'Show');
  const err = h('div', { class: 'err', role: 'alert' });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Sign in');
  let timer = 0;
  function lock(secs) {
    clearInterval(timer); let left = secs; submit.disabled = true;
    const tick = () => { if (left <= 0) { clearInterval(timer); submit.disabled = false; err.textContent = ''; return; } err.textContent = `Too many attempts. Try again in ${countdown(left * 1000)}.`; left--; };
    tick(); timer = setInterval(tick, 1000);
  }
  const form = h('form', { onsubmit: async (e) => {
    e.preventDefault(); err.textContent = ''; submit.disabled = true; submit.textContent = 'Signing in…';
    try {
      const r = await fetch('/auth/login', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw.value }) });
      if (r.ok) { pw.value = ''; onOk(); return; }
      if (r.status === 429) { lock(Number(r.headers.get('retry-after')) || 60); submit.textContent = 'Sign in'; return; }
      err.textContent = r.status === 403 ? 'Incorrect password.' : `Sign-in failed (HTTP ${r.status}).`;
    } catch { err.textContent = 'Cannot reach the server. Check your connection and retry.'; }
    submit.disabled = false; submit.textContent = 'Sign in'; pw.select();
  } },
    h('h1', {}, 'Options Desk'),
    h('p', { class: 'muted' }, 'Sign in to continue.'),
    h('label', { for: 'pw' }, 'Password'),
    h('div', { class: 'row' }, pw, toggle), err, submit,
    h('p', { class: 'legal' }, 'Unusual Whales data · Scores rank opportunities; they are not probabilities · Not financial advice'));
  mount(root, h('main', { class: 'login' }, form));
  pw.focus();
}
export async function logout() { try { await api('/auth/logout', { method: 'POST' }); } catch { /* ignore */ } }
