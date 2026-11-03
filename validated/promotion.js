// validated/promotion.js — the ONE promotion switch.
//
// validated/promotion.json is edited by a HUMAN. It decides which engine is the published (primary) score:
//   { "primary": "opt" | "v2", "approvedBy": "...", "approvedAt": "ISO date", "evidence": "..." }
// The default is "opt". Nothing in this repo ever writes this file. `primary: "v2"` only takes effect if
// approvedBy, approvedAt and evidence are all present — otherwise the loader falls back to "opt".
// readiness.promotionGate() only REPORTS eligibility; it cannot change anything.
import fs from 'node:fs';

export const DEFAULT_PROMOTION = Object.freeze({ primary: 'opt', approvedBy: null, approvedAt: null, evidence: null });

export function normalizePromotion(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const filled = (x) => typeof x === 'string' ? x.trim() !== '' : x != null && typeof x === 'object';
  if (p.primary === 'v2' && filled(p.approvedBy) && filled(p.approvedAt) && filled(p.evidence)) {
    return { primary: 'v2', approvedBy: p.approvedBy, approvedAt: p.approvedAt, evidence: p.evidence };
  }
  return { ...DEFAULT_PROMOTION, rejected: p.primary === 'v2' ? 'v2 requested without approvedBy/approvedAt/evidence; staying on opt' : undefined };
}

export function loadPromotion(file) {
  try { return normalizePromotion(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return { ...DEFAULT_PROMOTION }; }
}

// The single place that may let v2 replace the published score/dir/tier. Pure; no-op unless promoted.
export function applyPromotion(sig, v2, promotion) {
  if (!sig) return sig;
  const primary = promotion && promotion.primary === 'v2' && v2 && v2.available && Number.isFinite(v2.score) ? 'v2' : 'opt';
  sig.primaryEngine = primary;
  if (primary === 'v2') {
    sig.optScore = sig.finalScore; sig.optDir = sig.dir; sig.optTier = sig.tier;
    sig.finalScore = v2.score; sig.dir = v2.dir;
    sig.tier = v2.score >= 90 ? 'Exceptional' : v2.score >= 80 ? 'Very Strong' : v2.score >= 70 ? 'Strong' : v2.score >= 60 ? 'Moderate' : 'Weak';
  }
  return sig;
}
