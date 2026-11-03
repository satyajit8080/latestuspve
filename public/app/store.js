// Tiny pub/sub store. Display preferences are the only thing persisted (localStorage, guarded).
const safe = (fn, d) => { try { return fn(); } catch { return d; } };
const prefs = safe(() => JSON.parse(localStorage.getItem('ui.prefs') || '{}'), {});
export const state = {
  authed: null, authInfo: null, session: { state: 'CLOSED' }, scan: { running: false }, resolve: { running: false },
  signals: null, prevRanks: new Map(), readiness: null, monitor: null,
  conn: { failures: 0, since: null, lastOk: null }, quotaHistory: [],
  prefs: { density: prefs.density || 'compact', nav: prefs.nav || 'full', ...prefs },
};
const subs = new Set();
export const subscribe = (fn) => { subs.add(fn); return () => subs.delete(fn); };
export const emit = (what) => { for (const f of subs) f(what, state); };
export function setPref(k, v) { state.prefs[k] = v; safe(() => localStorage.setItem('ui.prefs', JSON.stringify(state.prefs))); emit('prefs'); }
// one-time cleanup of keys written by an earlier version of this client
safe(() => { for (const k of ['pve_history', 'pve_snaps', 'pve_cfg', 'pve_maph']) localStorage.removeItem(k); });
