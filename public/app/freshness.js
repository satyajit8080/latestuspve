// Snapshot freshness. Scans are MANUAL, so thresholds are generous; a closed market never shows red "expired".
const MIN = 60000;
export function freshness(ageMs, sessionState) {
  if (typeof ageMs !== 'number' || !Number.isFinite(ageMs)) return { level: 'idle', label: 'no snapshot' };
  const live = sessionState === 'RTH' || sessionState === 'HALF';
  const ext = sessionState === 'PRE' || sessionState === 'POST';
  if (live) return ageMs <= 10 * MIN ? { level: 'live', label: 'fresh' } : ageMs <= 30 * MIN ? { level: 'stale', label: 'aging' } : { level: 'offline', label: 'expired' };
  if (ext) return ageMs <= 30 * MIN ? { level: 'live', label: 'fresh' } : ageMs <= 120 * MIN ? { level: 'stale', label: 'aging' } : { level: 'stale', label: 'old' };
  return ageMs <= 24 * 60 * MIN ? { level: 'live', label: 'last session' } : { level: 'stale', label: 'old' };   // closed: never red
}
