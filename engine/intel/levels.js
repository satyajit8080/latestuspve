// engine/intel/levels.js — reference levels, never forecasts: support/resistance from GEX walls, VWAP and prior highs/lows,
// reference targets, an ATR-based invalidation, and the resulting risk/reward. Everything is labelled with its basis.
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const r2 = (x) => (isNum(x) ? Math.round(x * 100) / 100 : null);
export function levelsFor(f, dir) {
  const P = f.price; if (!P || !isNum(P.price)) return null; const px = P.price; const G = f.gex || {}; const atr = isNum(P.atr) ? P.atr : px * 0.02;
  const prior = (P.closes || []).slice(0, -1); const pd = prior.length ? prior[prior.length - 1] : null;
  const cands = [];
  const add = (price, basis) => { if (isNum(price) && price > 0) cands.push({ price: r2(price), basis }); };
  add(G.callWall, 'GEX call wall'); add(G.putWall, 'GEX put wall'); add(G.gammaFlip, 'gamma flip'); add(G.gammaMagnet, 'gamma magnet'); add(P.vwap, 'session VWAP'); add(P.hi20, 'prior 20-day high'); add(P.lo20, 'prior 20-day low'); if (pd) { add(pd.h, 'prior day high'); add(pd.l, 'prior day low'); }
  const resistance = cands.filter((c) => c.price > px).sort((a, b) => a.price - b.price), support = cands.filter((c) => c.price < px).sort((a, b) => b.price - a.price);
  const em = isNum(f.vol && f.vol.impliedMovePct) && f.vol.impliedMoveDte >= 5 ? px * f.vol.impliedMovePct : null;
  const up = dir !== 'bear'; const risk = up ? support : resistance, reward = up ? resistance : support; const nearRisk = risk[0] || null;
  let invalidation = null; if (nearRisk && Math.abs(px - nearRisk.price) <= 3 * atr) invalidation = { price: r2(up ? nearRisk.price - 0.25 * atr : nearRisk.price + 0.25 * atr), basis: `${nearRisk.basis} ${up ? 'minus' : 'plus'} 0.25 ATR` };
  else invalidation = { price: r2(up ? px - atr : px + atr), basis: '1 ATR from the current price (no nearby level)' };
  const targets = []; if (reward[0]) targets.push({ label: 'Reference level 1', price: reward[0].price, basis: reward[0].basis }); if (reward[1]) targets.push({ label: 'Reference level 2', price: reward[1].price, basis: reward[1].basis });
  if (em) targets.push({ label: 'Implied-move reference', price: r2(up ? px + em : px - em), basis: `options-implied move over ${f.vol.impliedMoveDte} days` }); if (!targets.length) targets.push({ label: 'ATR reference', price: r2(up ? px + 1.5 * atr : px - 1.5 * atr), basis: '1.5 ATR (no mapped level)' });
  const t1 = targets[0].price; const riskAmt = Math.abs(px - invalidation.price), rewardAmt = Math.abs(t1 - px); const rr = riskAmt > 0 ? rewardAmt / riskAmt : null;
  return { price: r2(px), support: support.slice(0, 4), resistance: resistance.slice(0, 4), targets, invalidation, riskReward: isNum(rr) ? Math.round(rr * 100) / 100 : null, atr: r2(atr), note: 'Reference levels from the data above. They are areas to watch, not predictions or guaranteed support/resistance.' };
}
