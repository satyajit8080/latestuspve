import { h, mount } from './dom.js';
import { state } from '../app/store.js';
import { etClock, countdown, ago, isNum } from '../app/fmt.js';
import { freshness } from '../app/freshness.js';
import { quotaMeter } from './parts.js';
import { marketSession } from '../app/session.js';

export function createStatusBar({ onRunScan, onLogout, onSignIn, cal }) {
  const bar = h('header', { class: 'statusbar', role: 'banner' });
  const prog = h('div', { class: 'progress', role: 'progressbar', aria: { label: 'Scan progress', hidden: 'true' } }, h('i', { class: 'bar' }));
  let lastLevel = null;
  function render() {
    const now = Date.now(), ms = marketSession(now, cal), snap = state.signals;
    const fr = freshness(snap && snap.generatedAtMs ? now - snap.generatedAtMs : null, ms.state);
    const sc = state.scan, up = state.readiness && state.readiness.uw, conn = state.conn;
    const rd = state.readiness && state.readiness.readiness && state.readiness.readiness.features;
    const states = rd ? Object.values(rd) : [];
    const rdLabel = !rd ? ['—', 'idle'] : states.every((s) => s === 'READY') ? ['READY', 'live'] : states.some((s) => s === 'WARMING_UP') ? ['WARMING UP', 'stale'] : ['NOT READY', 'stale'];
    const used = up ? (isNum(up.perMinuteUsed) && isNum(up.perMinuteLimit) ? up.perMinuteUsed : (isNum(up.uwMinuteLimit) && isNum(up.uwMinuteRemaining) ? up.uwMinuteLimit - up.uwMinuteRemaining : null)) : null;
    const limit = up ? (isNum(up.perMinuteLimit) ? up.perMinuteLimit : up.uwMinuteLimit) : null;
    const connState = state.authed === false ? ['Session expired', 'offline'] : conn.failures >= 3 ? ['Offline', 'offline'] : conn.failures > 0 ? ['Reconnecting…', 'stale'] : state.authInfo && state.authInfo.options && state.authInfo.options.configured === false ? ['UW not configured', 'stale'] : ['UW connected', 'live'];
    const breathe = ms.rth && fr.level === 'live' && conn.failures === 0 && !document.hidden;
    mount(bar,
      h('span', { class: 'brand' }, 'Options Desk'),
      h('span', { class: 'item', title: 'US market session, America/New_York' }, h('span', { class: `dot ${ms.rth ? 'live' : ms.state === 'PRE' || ms.state === 'POST' ? 'stale' : 'idle'} ${breathe ? 'breath' : ''}`, aria: { hidden: 'true' } }), h('span', {}, `${ms.label} ${etClock(now)} ET`), ms.nextChangeMs != null ? h('span', { class: 'dim m-hide' }, `· ${ms.nextLabel} ${countdown(ms.nextChangeMs)}`) : null),
      h('a', { class: 'item', href: '#/scan', title: 'Open the scan' }, h('span', { class: `dot ${fr.level}`, aria: { hidden: 'true' } }), h('span', {}, snap && snap.generatedAtMs ? `Snapshot ${ago(snap.generatedAtMs, now)} ago` : 'No snapshot')),
      h('span', { class: 'item m-hide' }, sc.running ? h('span', {}, `Scanning ${isNum(sc.done) && isNum(sc.total) ? `${sc.done}/${sc.total}` : '…'}${isNum(sc.etaMs) ? ` · ETA ${countdown(sc.etaMs)}` : ''}`) : sc.lastOk === false ? h('span', { class: 'bear' }, `Scan failed: ${String(sc.message || '').slice(0, 50)}`) : h('span', { class: 'dim' }, sc.lastOk ? 'Scan idle · last ok' : 'Scan idle')),
      h('span', { class: 'item m-hide' }, quotaMeter(used, limit)),
      h('span', { class: 'item m-hide', title: 'Research feature readiness' }, h('span', { class: `dot ${rdLabel[1]}`, aria: { hidden: 'true' } }), h('span', {}, rdLabel[0])),
      h('span', { class: 'grow' }),
      h('span', { class: 'item', role: 'status' }, h('span', { class: `dot ${connState[1]}`, aria: { hidden: 'true' } }), h('span', {}, connState[0]), state.authed === false ? h('button', { class: 'btn', onclick: onSignIn }, 'Sign in') : null),
      h('button', { class: 'item', onclick: onLogout, title: 'Sign out' }, 'Sign out'));
    // progress bar under the status bar: determinate when done/total are known, thin indeterminate while running
    const running = !!sc.running;
    prog.setAttribute('aria-hidden', running ? 'false' : 'true');
    prog.classList.toggle('indet', running && !(isNum(sc.done) && isNum(sc.total) && sc.total > 0));
    if (running && isNum(sc.done) && isNum(sc.total) && sc.total > 0) prog.style.setProperty('--pct', Math.min(1, sc.done / sc.total)); else prog.style.removeProperty('--pct');
    prog.hidden = !running;
    lastLevel = fr.level;
  }
  return { bar, prog, render, getLevel: () => lastLevel };
}
