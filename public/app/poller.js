// Session-aware polling of ZERO-UW-COST endpoints only. Pauses when hidden, backs off x2 (max 60 s) on errors, +-10% jitter.
export const POLLABLE = ['/api/scan/status', '/api/signals/us', '/api/research/readiness', '/auth/status', '/api/journal/resolve/status'];
const TABLE = {   // seconds: [RTH, PRE/POST, CLOSED, scanRunning]
  scan: [15, 30, 120, 2], signals: [30, 60, 0, 5], readiness: [15, 30, 120, 5], auth: [120, 120, 300, 0], resolve: [30, 60, 120, 5],
};
export function cadenceMs(key, sessionState, scanRunning) {
  const row = TABLE[key]; if (!row) return 0;
  if (scanRunning) return row[3] * 1000;
  const live = sessionState === 'RTH' || sessionState === 'HALF', ext = sessionState === 'PRE' || sessionState === 'POST';
  return (live ? row[0] : ext ? row[1] : row[2]) * 1000;
}
export const backoff = (baseMs, failures) => (failures <= 0 ? baseMs : Math.min(60000, Math.max(baseMs, 1000) * 2 ** failures));
export const jitter = (ms, rnd = Math.random) => Math.round(ms * (0.9 + rnd() * 0.2));
// jobs: { key, run:async()=>void (throws on failure), enabled?:()=>bool }
export function createPoller({ jobs, getSession, isScanRunning, onFailure, onSuccess }) {
  const state = new Map(); let stopped = true;
  const sched = (job, delay) => { clearTimeout(state.get(job.key)?.timer); const st = state.get(job.key) || { failures: 0 }; st.timer = setTimeout(() => tick(job), delay); state.set(job.key, st); };
  async function tick(job) {
    if (stopped) return;
    const st = state.get(job.key) || { failures: 0 };
    if (document.hidden || (job.enabled && !job.enabled())) return sched(job, 5000);
    try { await job.run(); st.failures = 0; onSuccess && onSuccess(job.key); }
    catch (e) { st.failures++; onFailure && onFailure(job.key, st.failures, e); }
    state.set(job.key, st);
    const base = cadenceMs(job.key, getSession().state, isScanRunning());
    if (!base) return sched(job, 30000);                  // cadence 0 = "on demand": just re-check the schedule later
    sched(job, jitter(backoff(base, st.failures)));
  }
  const onVis = () => { if (!document.hidden && !stopped) for (const j of jobs) sched(j, 0); };
  return {
    start() { stopped = false; document.addEventListener('visibilitychange', onVis); for (const j of jobs) sched(j, 0); },
    stop() { stopped = true; document.removeEventListener('visibilitychange', onVis); for (const s of state.values()) clearTimeout(s.timer); },
    nudge(key) { const j = jobs.find((x) => x.key === key); if (j && !stopped) sched(j, 0); },
  };
}
