// Maps a scan-cache row (today's or the planned shape) onto ONE view model. Picks/renames fields only: no scoring.
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
export function adaptScanRow(r) {
  if (!r || !r.ticker) return null;
  const score = isNum(r.productionScore) ? r.productionScore : (isNum(r.score) ? r.score : null);
  const gates = Array.isArray(r.gateReasons) ? r.gateReasons.slice() : [];
  if (r.gated && !gates.includes('EARNINGS')) gates.push('EARNINGS');
  if (r.tradeable === false && !gates.some((g) => /SPREAD|OI|LIQ/.test(g))) gates.push('ILLIQUID');
  if (r.outsideRth && !gates.includes('OUTSIDE_RTH')) gates.push('OUTSIDE_RTH');
  return {
    ticker: r.ticker, sector: r.sector || null, dir: r.dir === 'bull' || r.dir === 'bear' ? r.dir : 'neutral',
    signal: r.signal || null, score, rawScore: isNum(r.rawScore) ? r.rawScore : null, gated: !!r.gated, tier: r.tier || null,
    coverage: isNum(r.coverage) ? r.coverage : (isNum(r.dataQuality) ? r.dataQuality / 100 : null),
    gates, actionable: r.actionable ?? null, price: isNum(r.price) ? r.price : null, changePct: isNum(r.changePct) ? r.changePct : null,
    vsVwapPct: isNum(r.vsVwapPct) ? r.vsVwapPct : null, rvol: isNum(r.relativeVolume) ? r.relativeVolume : null,
    oiNet: isNum(r.oiChangeNet) ? r.oiChangeNet : null, ivr: isNum(r.ivRank) ? r.ivRank : null,
    updatedAt: r.updatedAt ? Date.parse(r.updatedAt) : null, error: r.error || null, engineVersion: r.engineVersion || null,
    v2: { score: isNum(r.v2Score) ? r.v2Score : null, dir: r.v2Dir || null, coverage: isNum(r.v2Coverage) ? r.v2Coverage : null },
  };
}
export const adaptScanRows = (rows) => (rows || []).map(adaptScanRow).filter((r) => r && !r.error);
