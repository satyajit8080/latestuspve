// engine/intel/score.js — transparent 0-100 intelligence score, bullish and bearish SEPARATELY.
// Correlated inputs are grouped into FAMILIES and each family votes ONCE (members are averaged, never summed), so premium
// imbalance, tape and opening-share cannot triple-count the same trade flow. Weights are PRIORS, not fitted: they are marked
// unvalidated until the backtest in this module supports them. The engine may return NO_TRADE; it is never forced to pick a side.
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
import { MIN_FLOW_PREMIUM } from './features.js';

export const WEIGHTS = { flow: 30, oi: 12, gex: 15, price: 20, volume: 8 };
export const SCORE_VERSION = 'intel-score-0.1.0 (prior weights, unvalidated)';
export const THRESHOLDS = { enter: 55, margin: 12, maxSpread: 0.15, earningsBlockDays: 2, minPriceEvidence: 0.1 };
const LABELS = { flow: 'Options flow (premium imbalance, tape, opening activity)', oi: 'Open-interest confirmation', gex: 'Dealer positioning (GEX, walls, flip)', price: 'Price action and confirmation', volume: 'Relative volume' };

function flowEvidence(F, T, s) {
  if (!F || F.imbalance == null) return null; const members = [];
  const sizeScale = clamp(F.singlePremium / MIN_FLOW_PREMIUM, 0, 1);
  members.push({ k: 'Aggressor-signed premium imbalance', value: F.imbalance, e: clamp(s * F.imbalance / 0.6, -1, 1), w: 0.7 });
  if (T && T.imbalance != null) members.push({ k: 'One-minute tape net premium', value: T.imbalance, e: clamp(s * T.imbalance / 0.6, -1, 1), w: 0.3 });
  const wsum = members.reduce((a, m) => a + m.w, 0); let e = members.reduce((a, m) => a + m.e * m.w, 0) / wsum;
  const quality = clamp(0.5 + 0.5 * (F.openingShare ?? 0), 0.5, 1) * (F.multiLegShare != null && F.multiLegShare > 0.6 ? 0.7 : 1);   // opening activity raises confidence; spread-dominated flow lowers it
  e *= quality * sizeScale;
  return { e, members, note: `single-leg premium $${Math.round(F.singlePremium / 1000)}k, opening ${F.openingShare != null ? Math.round(F.openingShare * 100) + '%' : 'n/a'}, multi-leg ${F.multiLegShare != null ? Math.round(F.multiLegShare * 100) + '%' : 'n/a'}${sizeScale < 1 ? ' (small size: scaled down)' : ''}` };
}
function oiEvidence(O, s) { if (!O || O.imbalance == null) return null; const e = clamp(s * O.imbalance / 0.5, -1, 1) * (O.volOiHits > 0 ? 1 : 0.7); return { e, members: [{ k: 'Call minus put OI change', value: O.imbalance, e, w: 1 }], note: `OI change published after the prior session; ${O.volOiHits} contract(s) with volume above OI` }; }
function gexEvidence(G, P, s) {
  if (!G || !P) return null; const m = []; const chg = P.chgPct; const px = P.price;
  if (G.regime === 'negative') m.push({ k: 'Negative net gamma: hedging can amplify moves', value: G.netGamma, e: isNum(chg) ? clamp(s * Math.sign(chg) * 0.6, -1, 1) : 0, w: 1 });
  else if (G.regime === 'positive') m.push({ k: 'Positive net gamma: hedging tends to dampen moves', value: G.netGamma, e: 0.1, w: 1 });
  const d = G.dist || {}; const near = (v) => isNum(v) && Math.abs(v) <= 0.015;
  if (s > 0) { if (near(d.callWall) && d.callWall > 0) m.push({ k: 'Call wall within 1.5% above (possible resistance)', value: d.callWall, e: -0.5, w: 1 }); if (near(d.putWall) && d.putWall < 0) m.push({ k: 'Put wall within 1.5% below (possible support)', value: d.putWall, e: 0.4, w: 1 }); }
  else { if (near(d.putWall) && d.putWall < 0) m.push({ k: 'Put wall within 1.5% below (possible support for price)', value: d.putWall, e: -0.5, w: 1 }); if (near(d.callWall) && d.callWall > 0) m.push({ k: 'Call wall within 1.5% above (possible resistance)', value: d.callWall, e: 0.4, w: 1 }); }
  if (isNum(G.gammaFlip) && isNum(px)) m.push({ k: px > G.gammaFlip ? 'Price above the gamma flip' : 'Price below the gamma flip', value: (px - G.gammaFlip) / px, e: s * (px > G.gammaFlip ? 0.2 : -0.2), w: 1 });
  if (!m.length) return null; return { e: clamp(m.reduce((a, x) => a + x.e * x.w, 0) / m.reduce((a, x) => a + x.w, 0), -1, 1), members: m, note: 'levels are areas to watch, not guaranteed support or resistance' };
}
function priceEvidence(P, s) {
  if (!P) return null; const m = []; const atrp = P.atrPct;
  if (isNum(P.mom5) && isNum(atrp) && atrp > 0) m.push({ k: '5-day trend vs ATR', value: P.mom5, e: clamp(s * P.mom5 / (3 * atrp), -1, 1), w: 1 });
  if (isNum(P.vsVwapPct)) m.push({ k: 'Price vs session VWAP', value: P.vsVwapPct, e: clamp(s * P.vsVwapPct / 0.01, -1, 1), w: 1 });
  const bo = s > 0 ? P.breakoutUp : P.breakoutDown; if (bo != null) m.push({ k: s > 0 ? 'Breaks the prior 20-day high' : 'Breaks the prior 20-day low', value: bo ? 1 : 0, e: bo ? (isNum(P.rvol) && P.rvol >= 1.2 ? 1 : 0.5) : 0, w: 1 });
  if (isNum(P.chgPct) && isNum(atrp) && atrp > 0 && s * P.chgPct > 2.5 * atrp) m.push({ k: 'Move already extended (> 2.5 ATR): one-day reversal risk', value: P.chgPct, e: -0.6, w: 1 });
  if (!m.length) return null; return { e: clamp(m.reduce((a, x) => a + x.e * x.w, 0) / m.reduce((a, x) => a + x.w, 0), -1, 1), members: m, note: 'the underlying must confirm the options thesis' };
}
function volumeEvidence(P, s) { if (!P || !isNum(P.rvol)) return null; const confirm = isNum(P.chgPct) && s * P.chgPct > 0; const e = clamp((P.rvol - 1) / 1.5, 0, 1) * (confirm ? 1 : 0.3); return { e, members: [{ k: `Relative volume (${P.rvolBasis})`, value: P.rvol, e, w: 1 }], note: 'counts only when price moves the same way' }; }

export function scoreDirection(f, dir) {
  const s = dir === 'bull' ? 1 : -1; const fam = { flow: flowEvidence(f.flow, f.tape, s), oi: oiEvidence(f.oi, s), gex: gexEvidence(f.gex, f.price, s), price: priceEvidence(f.price, s), volume: volumeEvidence(f.price, s) };
  const avail = Object.entries(fam).filter(([, v]) => v); const wAvail = avail.reduce((a, [k]) => a + WEIGHTS[k], 0); const wTot = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  const coverage = wAvail / wTot; const cf = 0.5 + 0.5 * coverage;
  const components = Object.entries(fam).map(([k, v]) => ({ family: k, label: LABELS[k], available: !!v, weight: WEIGHTS[k], evidence: v ? v.e : null, contribution: v && wAvail ? 100 * WEIGHTS[k] * v.e / wAvail * cf : 0, members: v ? v.members : [], note: v ? v.note : 'unavailable: not scored' }));
  const base = Math.max(0, components.reduce((a, c) => a + c.contribution, 0)); const mods = [];
  const V = f.vol; if (V && isNum(V.ivRank) && V.ivRank > 80) mods.push({ k: `IV rank ${Math.round(V.ivRank)} (long options are expensive)`, mult: 0.85 }); if (V && isNum(V.ivRvRatio) && V.ivRvRatio > 1.5) mods.push({ k: `IV is ${V.ivRvRatio.toFixed(1)}x realized volatility`, mult: 0.9 });
  if (f.liquidity && f.liquidity.level === 'LOW') mods.push({ k: 'Low option liquidity', mult: 0.8 });
  const score = clamp(Math.round(base * mods.reduce((a, m) => a * m.mult, 1)), 0, 100);
  return { dir, score, base: Math.round(base), coverage: Math.round(coverage * 100) / 100, components, modifiers: mods, priceEvidence: fam.price ? fam.price.e : null };
}
export function gates(f) {
  const g = []; const L = f.liquidity, F = f.flow;
  if (F && F.daysToEarnings != null && F.daysToEarnings <= THRESHOLDS.earningsBlockDays) g.push(`Earnings in ${F.daysToEarnings} day(s): gap and volatility-crush risk`);
  if (L && L.atmSpreadPct != null && L.atmSpreadPct > THRESHOLDS.maxSpread) g.push(`Option spread ${Math.round(L.atmSpreadPct * 100)}% is too wide to trade`);
  if (L && L.optVolume === 0) g.push('No option volume');
  if (!F) g.push('No options flow available'); if (!f.price) g.push('No price data to confirm the thesis');
  return g;
}
export function evaluate(f) {
  const bull = scoreDirection(f, 'bull'), bear = scoreDirection(f, 'bear'); const reasons = gates(f); const T = THRESHOLDS;
  const top = bull.score >= bear.score ? bull : bear, other = top === bull ? bear : bull; let state = 'NO_TRADE', direction = null;
  if (!reasons.length) {
    if (top.score >= T.enter && top.score - other.score >= T.margin) {
      if (top.priceEvidence == null || top.priceEvidence < T.minPriceEvidence) reasons.push('No price confirmation: the underlying has not confirmed the options activity');
      else { state = top.dir === 'bull' ? 'BULL' : 'BEAR'; direction = top.dir; }
    } else if (top.score >= T.enter && other.score >= T.enter - T.margin) reasons.push('Conflicting bullish and bearish evidence');
    else reasons.push(`Evidence too weak (best ${top.score}, needs ${T.enter})`);
  }
  return { state, direction, reasons, bull, bear, version: SCORE_VERSION };
}
