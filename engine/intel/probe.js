// engine/intel/probe.js — live check of every endpoint Options Intelligence uses: status, row count, field names, missing expected fields.
import { INTEL_ENDPOINTS } from './endpoints.js';
import { rowsOf, objOf } from './normalize.js';
export async function probeEndpoints(adapter, ticker = 'AAPL', { now = () => Date.now(), date = null } = {}) {
  const results = {};
  for (const [key, def] of Object.entries(INTEL_ENDPOINTS)) {
    const args = key === 'marketTide' || key === 'screener' ? [] : key === 'gexLevels' ? [ticker, date] : [ticker];
    const r = await adapter.fetch(key, ...args); const rows = r.ok ? rowsOf(r.json) : []; const first = r.ok ? (rows[0] || objOf(r.json)) : null;
    results[key] = { ok: r.ok, verified: def.verified, rows: rows.length, keys: first && typeof first === 'object' ? Object.keys(first).slice(0, 60) : [], missing: r.schemaMissing || [], error: r.error || null };
  }
  return { at: new Date(now()).toISOString(), ticker, results };
}
