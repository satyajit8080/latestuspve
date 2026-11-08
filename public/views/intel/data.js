import { api } from '../../app/api.js';
import { toast } from '../../ui/toast.js';

export function createIntelData() {
  const d = { latest: null, status: null, flow: null, snapshot: '', loading: true, error: null }; const subs = new Set(); let alive = true, timer = 0;
  const emit = () => { if (alive) subs.forEach((f) => f(d)); };
  async function refreshStatus() { try { const r = await api('/api/intel/status'); if (r.ok && r.data) { d.status = r.data; d.error = null; } } catch { d.error = 'Cannot reach the server.'; } }
  async function refreshLatest(force = false) {
    try { const q = d.snapshot ? `?snapshot=${encodeURIComponent(d.snapshot)}` : ''; const r = await api(`/api/intel/latest${q}`, { useEtag: !force && !d.snapshot && !!d.latest }); if (r.notModified) return; if (r.ok && r.data) d.latest = r.data; } catch { d.error = 'Cannot reach the server.'; }
    d.loading = false;
  }
  async function loadFlow(force = false) { try { const r = await api('/api/intel/flow', { useEtag: !force && !!d.flow }); if (r.notModified) return; if (r.ok && r.data) { d.flow = r.data; emit(); } } catch { /* the flow view shows an empty state */ } }
  async function tick() {
    await refreshStatus(); const run = !!(d.status && d.status.scan && d.status.scan.running); const sl = d.status && d.status.latest;
    if (!d.snapshot && (run || !d.latest || (sl && (d.latest.generatedAt !== sl.generatedAt || d.latest.done !== sl.done || d.latest.stage !== sl.stage)))) await refreshLatest();
    d.loading = false; emit(); if (alive) timer = setTimeout(tick, run ? 4000 : 30000);
  }
  return Object.assign(d, {
    subscribe(f) { subs.add(f); return () => subs.delete(f); }, start() { alive = true; tick(); }, loadFlow, refreshLatest,
    async setSnapshot(v) { d.snapshot = v || ''; d.latest = null; d.loading = true; emit(); await refreshLatest(true); emit(); },
    async runScan(deepN) { const r = await api('/api/intel/scan', { method: 'POST', body: deepN ? { deepN } : {} }); const j = r.data || {}; if (!r.ok || j.ok === false) { toast(j.error || 'Scan could not start', 'err'); return false; } toast('Options Intelligence scan started'); clearTimeout(timer); tick(); return true; },
    destroy() { alive = false; clearTimeout(timer); subs.clear(); },
  });
}
