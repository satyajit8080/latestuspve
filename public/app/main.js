import { h, mount, $, $$ } from '../ui/dom.js';
import { state, subscribe, emit, setPref } from './store.js';
import { api } from './api.js';
import { createPoller } from './poller.js';
import { onRoute, navigate, buildHash } from './router.js';
import { marketSession } from './session.js';
import { createStatusBar } from '../ui/status-bar.js';
import { createInspector } from '../ui/inspector.js';
import { openPalette, installShortcuts, shortcutSheet } from '../ui/palette.js';
import { openDialog } from '../ui/dialog.js';
import { toast } from '../ui/toast.js';
import { renderLogin, logout } from '../views/login.js';
import { renderScan, ranksOf } from '../views/scan.js';
import { renderTicker } from '../views/ticker.js';
import { renderJournal } from '../views/journal.js';
import { renderShadow } from '../views/shadow.js';
import { renderSystem } from '../views/system.js';
import { adaptScanRows } from '../adapt/scanRow.js';
import { diffRows } from '../ui/table-diff.js';

const root = document.getElementById('root');
let cal = { holidays: [], halfDays: [] }, poller = null, view = null, bar = null, inspector = null, appShell = null, clockTimer = 0, tickTimer = 0, reauth = null, lastRoute = null;
const NAV = [['scan', 'Scan', 'g s'], ['t', 'Ticker', 'g t'], ['journal', 'Journal', 'g j'], ['shadow', 'Shadow', 'g h'], ['system', 'System', 'g y']];

function applyDensity() {
  const coarse = matchMedia('(pointer: coarse)').matches;
  const d = coarse ? 'touch' : state.prefs.density;
  document.documentElement.style.setProperty('--row-h-current', d === 'touch' ? 'var(--row-h-comfy)' : d === 'comfortable' ? 'var(--row-h)' : 'var(--row-h-compact)');
}
async function loadCal() { try { const r = await fetch('data/nyse-calendar.json'); if (r.ok) cal = await r.json(); } catch { /* session falls back to weekday hours */ } }
const sessionNow = () => { state.session = marketSession(Date.now(), cal); return state.session; };

async function pollScanStatus() {
  const r = await api('/api/scan/status'); if (!r.ok || !r.data) return;
  const was = state.scan.running; state.scan = r.data; emit('scan');
  if (was && !r.data.running) { await pollSignals(true); announceScan(); }
}
let lastRows = null;
function announceScan() {
  if (state.scan.lastOk === false) return toast(`Scan failed: ${state.scan.message || 'unknown error'}`, 'err');
  const rows = adaptScanRows(state.signals && state.signals.rows);
  if (!rows.length) return toast('Scan finished with no scored tickers', 'warn');
  const d = diffRows(lastRows || [], rows, (r) => r.ticker, ['score', 'dir']);
  toast(lastRows ? `Scan complete: ${rows.length} tickers · ${d.changed.size} changed · ${d.added.length} new · ${d.removed.length} dropped` : `Scan complete: ${rows.length} tickers`);
  lastRows = rows;
}
async function pollSignals(force) {
  const r = await api('/api/signals/us?limit=500', { useEtag: !force });
  if (r.notModified || !r.ok || !r.data) return;
  const d = r.data;
  if (!d.available) { state.signals = null; emit('signals'); return; }
  const prev = state.signals;
  const ms = Date.parse(d.generatedAt);
  if (prev && prev.generatedAt !== d.generatedAt) state.prevRanks = ranksOf(adaptScanRows(prev.rows));
  state.signals = { ...d, generatedAtMs: ms };
  if (!lastRows) lastRows = adaptScanRows(d.rows);
  emit('signals');
}
async function pollReadiness() {
  const r = await api('/api/research/readiness'); if (!r.ok || !r.data) return;
  state.readiness = r.data; const uw = r.data.uw || {};
  const used = typeof uw.perMinuteUsed === 'number' ? uw.perMinuteUsed : (typeof uw.uwMinuteLimit === 'number' && typeof uw.uwMinuteRemaining === 'number' ? uw.uwMinuteLimit - uw.uwMinuteRemaining : null);
  if (used != null) { state.quotaHistory.push({ t: Date.now(), used }); if (state.quotaHistory.length > 120) state.quotaHistory.shift(); }
  emit('readiness');
}
async function pollAuth() { const r = await api('/auth/status'); if (r.ok && r.data) { state.authInfo = r.data; if (r.data.authed === false) { state.authed = false; emit('auth'); } else if (!state.authed) { state.authed = true; emit('auth'); } } }
async function pollResolve() { const r = await api('/api/journal/resolve/status'); if (r.ok && r.data) { const was = state.resolve.running; state.resolve = r.data; emit('resolve'); if (was && !r.data.running) toast(r.data.lastOk ? `Outcomes resolved: ${r.data.message || ''}` : `Resolve failed: ${r.data.message || ''}`, r.data.lastOk ? '' : 'err'); } }

async function runScan() {
  const r = await api('/api/scan/run', { method: 'POST', body: { limit: 600 } });
  if (r.status === 409) return toast('A scan is already running', 'warn');
  if (!r.ok || !r.data || !r.data.ok) return toast(`Could not start the scan: ${(r.data && (r.data.error || r.data.reason)) || 'error'}`, 'err');
  state.scan = { ...state.scan, ...r.data.state, running: true }; emit('scan'); poller && poller.nudge('scan');
  toast('Scan started. This spends Unusual Whales quota.');
}
async function resolveOutcomes() { const r = await api('/api/journal/resolve', { method: 'POST' }); if (r.ok && r.data && r.data.ok) { toast('Resolving outcomes…'); poller && poller.nudge('resolve'); } else toast((r.data && r.data.error) || 'Could not start', 'err'); }

function startPolling() {
  if (poller) poller.stop();
  poller = createPoller({
    getSession: sessionNow, isScanRunning: () => !!state.scan.running,
    jobs: [{ key: 'scan', run: pollScanStatus }, { key: 'signals', run: () => pollSignals(false) }, { key: 'readiness', run: pollReadiness }, { key: 'auth', run: pollAuth }, { key: 'resolve', run: pollResolve }],
    onSuccess: () => { if (state.conn.failures) { state.conn = { failures: 0, since: null, lastOk: Date.now() }; emit('conn'); toast('Reconnected'); } else state.conn.lastOk = Date.now(); },
    onFailure: (key, n) => { state.conn.failures = Math.max(state.conn.failures, n); state.conn.since = state.conn.since || Date.now(); emit('conn'); },
  });
  poller.start();
  clearInterval(clockTimer); clockTimer = setInterval(() => { if (!document.hidden && bar) { sessionNow(); bar.render(); } }, 1000);
  clearInterval(tickTimer); tickTimer = setInterval(() => { if (!document.hidden) { sessionNow(); emit('tick'); } }, 15000);
}
function stopPolling() { if (poller) poller.stop(); clearInterval(clockTimer); clearInterval(tickTimer); }

function showReauth() {
  if (reauth) return;
  const body = h('div'); renderLogin(body, () => { reauth.close(); });
  reauth = openDialog({ title: 'Session expired', body, onClose: () => { reauth = null; state.authed = true; emit('auth'); if (poller) for (const k of ['scan', 'signals', 'readiness', 'auth']) poller.nudge(k); } });
}

function buildShell() {
  const nav = h('nav', { class: 'nav', 'aria-label': 'Primary' }, NAV.map(([k, label, keys]) => h('a', { href: buildHash(k), dataset: { view: k }, class: k === 'shadow' ? 'm-hide' : '' }, h('span', { class: 'label' }, label), h('span', { class: 'k' }, keys))),
    h('span', { class: 'sp' }),
    h('button', { class: 'desk-only', onclick: () => setPref('nav', state.prefs.nav === 'rail' ? 'full' : 'rail'), 'aria-label': 'Collapse navigation' }, h('span', { class: 'label' }, 'Collapse')),
    h('button', { class: 'm-hide', onclick: () => shortcutSheet() }, h('span', { class: 'label' }, 'Shortcuts'), h('span', { class: 'k' }, '?')),
    h('div', { class: 'foot' }, 'Unusual Whales data. Scores rank opportunities; they are not probabilities. Not financial advice.'));
  const sb = createStatusBar({ cal, onRunScan: runScan, onLogout: async () => { stopPolling(); await logout(); state.authed = false; state.signals = null; boot(); }, onSignIn: showReauth });
  bar = sb;
  const main = h('main', { class: 'main', id: 'main', tabindex: '-1' });
  appShell = h('div', { id: 'app', dataset: { nav: state.prefs.nav } }, sb.bar, sb.prog, nav, main);
  return { shell: appShell, main, nav, inspectorEl: null, sb };
}

function actions() {
  const out = NAV.map(([k, l, keys]) => ({ label: `Go to ${l}`, hint: keys, run: () => navigate(buildHash(k)) }));
  out.push({ label: 'Run scan', hint: 'spends quota', run: runScan }, { label: 'Resolve outcomes', hint: 'spends quota', run: resolveOutcomes },
    { label: `Density: ${state.prefs.density === 'compact' ? 'comfortable' : 'compact'}`, run: () => { setPref('density', state.prefs.density === 'compact' ? 'comfortable' : 'compact'); } },
    { label: 'Keyboard shortcuts', hint: '?', run: shortcutSheet });
  return out;
}

let shell = null, mainEl = null;
function route(r) {
  lastRoute = r;
  if (!shell) return;
  if (view && view.destroy) view.destroy(); view = null; inspector.hide();
  for (const a of shell.querySelectorAll('.nav a')) { const on = a.dataset.view === r.view; if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); }
  const ctx = { query: r.query, cal, runScan, inspector, refresh: () => pollSignals(true) };
  if (r.view === 'scan') view = renderScan(mainEl, ctx);
  else if (r.view === 't') view = renderTicker(mainEl, { ticker: r.param ? r.param.toUpperCase() : null, cal });
  else if (r.view === 'journal') view = renderJournal(mainEl, ctx);
  else if (r.view === 'shadow') view = renderShadow(mainEl);
  else if (r.view === 'system') view = renderSystem(mainEl, { cal, runScan });
  else navigate(buildHash('scan'));
  document.title = `${r.view === 't' && r.param ? r.param.toUpperCase() : r.view[0].toUpperCase() + r.view.slice(1)} · Options Desk`;
}

function startApp() {
  mount(root);
  const b = buildShell(); shell = b.shell; mainEl = b.main;
  const insp = h('aside', { class: 'inspector', 'aria-hidden': 'true' }); inspector = createInspector(insp); shell.append(insp);
  mount(root, shell);
  applyDensity(); sessionNow(); bar.render();
  installShortcuts({ palette: () => openPalette(actions), help: shortcutSheet, go: (v) => navigate(buildHash(v)), focusSearch: () => { const s = $('[data-search]'); if (s) s.focus(); else if (view && view.focusSearch) view.focusSearch(); } });
  startPolling();
  onRoute(route);
}
let started = false;
subscribe((what) => {
  if (what === 'prefs') { applyDensity(); if (shell) shell.dataset.nav = state.prefs.nav; }
  if (['scan', 'signals', 'readiness', 'conn', 'auth', 'tick', 'resolve'].includes(what) && bar) { sessionNow(); bar.render(); }
  if (what === 'auth' && state.authed === false && shell) showReauth();
});
async function boot() {
  await loadCal();
  let st; try { st = await api('/auth/status'); } catch { st = null; }
  if (!st || !st.data) return mount(root, h('main', { class: 'login' }, h('div', { class: 'banner err', role: 'alert' }, 'Cannot reach the server.', h('button', { class: 'btn', onclick: boot }, 'Retry'))));
  state.authInfo = st.data;
  if (!st.data.authed) { state.authed = false; shell = null; return renderLogin(root, () => { state.authed = true; boot(); }); }
  state.authed = true; if (!started) { started = true; } startApp();
}
boot();
