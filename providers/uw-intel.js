// providers/uw-intel.js — thin, non-throwing adapter over the existing Unusual Whales provider (shared limiter, retries, token handling).
// Every call returns { ok, key, json, rows, error, status, retrievedAt, verified, schemaMissing } and never throws.
import { INTEL_ENDPOINTS } from '../engine/intel/endpoints.js';
import { rowsOf, objOf } from '../engine/intel/normalize.js';

export function schemaMissing(key, json) {
  const exp = (INTEL_ENDPOINTS[key] && INTEL_ENDPOINTS[key].expect) || []; if (!exp.length) return [];
  const rows = rowsOf(json); const first = rows[0] || objOf(json); if (!first || typeof first !== 'object') return [];
  return exp.filter((k) => !(k in first));
}
export function createIntelAdapter(provider, { now = () => Date.now() } = {}) {
  return {
    available: () => !!(provider && typeof provider._get === 'function'),
    async fetch(key, ...args) {
      const def = INTEL_ENDPOINTS[key]; const retrievedAt = now(); if (!def) return { ok: false, key, error: `unknown endpoint ${key}`, retrievedAt };
      if (!provider || typeof provider._get !== 'function') return { ok: false, key, error: 'no Unusual Whales provider configured', retrievedAt, verified: def.verified };
      try { const json = await provider._get(def.path(...args)); const rows = rowsOf(json); return { ok: true, key, json, rows: rows.length, retrievedAt, verified: def.verified, schemaMissing: schemaMissing(key, json) }; }
      catch (e) { const msg = String((e && e.message) || e).replace(/Bearer\s+\S+/g, 'Bearer ***').slice(0, 200); return { ok: false, key, error: msg, rateLimited: !!(e && e.rateLimited) || /429/.test(msg), retrievedAt, verified: def.verified }; }
    },
    stats: () => (provider && provider.limiter && provider.limiter.stats ? provider.limiter.stats() : null),
  };
}
