// @ts-check
/*
 * options-engine.js — PRODUCTION signal engine (opt-1.2.0) over real Unusual Whales options data.
 *
 * Deterministic and pure. Principles:
 *  1. DIRECTION comes only from aggressor-signed money, normalised per ticker against its own history:
 *       signedPremium (ask-side minus bid-side premium, calls + / puts -)        weight 0.50
 *       oiChange      (UW daily OI change, net calls vs puts)                    weight 0.25
 *       cpVolumeZ     (log call/put volume vs the ticker's own history)          weight 0.25
 *     Raw call-vs-put counts are never a direction (calls always trade more than puts: that is a permanent bull bias).
 *  2. Confirmations GATE or CAP the score; they never add points: price-vs-VWAP (x0.75 on conflict), liquidity,
 *     earnings, regular trading hours, and "need >= 2 of 3 directional features".
 *  3. Every point of the score comes from available, measured evidence. Missing data is `avail:0` and flagged;
 *     it is never 0, never a default direction and never a fake ratio.
 *  4. GEX / gamma regime / IV rank / max pain / walls are context for display and the journal. They do not enter the
 *     score until evaluation shows they add rank IC.
 *
 * Score = 100 x |net| x coverage, where net = weighted mean of the available directional strengths and
 * coverage = share of directional weight available.
 */
import { isRth } from '../lib/time.js';

export const OPTIONS_ENGINE_VERSION = 'opt-1.2.0';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const sum = (a) => a.reduce((s, x) => s + (isNum(x) ? x : 0), 0);
const mean = (a) => { const b = a.filter(isNum); return b.length ? sum(b) / b.length : null; };   // empty -> null, never 0
function median(a) { const b = a.filter(isNum).slice().sort((x, y) => x - y); if (!b.length) return null; const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; }
function hhi(vals) { const t = sum(vals); if (!(t > 0)) return null; return sum(vals.map((v) => (v / t) ** 2)); }   // 0..1 concentration
const sgn = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);

export const SCORE_TIERS = [[90, 'Exceptional'], [80, 'Very Strong'], [70, 'Strong'], [60, 'Moderate'], [0, 'Weak']];
export function scoreTier(s) { for (const [m, l] of SCORE_TIERS) if (s >= m) return l; return 'Weak'; }

/** The only scored features. All directional. */
export const OPTIONS_FEATURE_DEFS = {
  signedPremium: { name: 'Aggressor-signed premium flow', weight: 0.50, directional: true, source: 'UW flow-alerts (session) / net-prem-ticks', explain: 'Ask-side minus bid-side premium, calls positive and puts negative' },
  oiChange: { name: 'Open-interest change', weight: 0.25, directional: true, source: 'UW /oi-change (daily)', explain: 'Net call vs put open-interest change over previous total OI' },
  cpVolumeZ: { name: 'Call/put volume skew vs own history', weight: 0.25, directional: true, source: 'chain volume + ticker baseline', explain: 'log((callVol+1)/(putVol+1)) as a z-score against this ticker\'s own prior sessions' },
};

export const DEFAULT_OPTIONS_CFG = {
  weights: Object.fromEntries(Object.entries(OPTIONS_FEATURE_DEFS).map(([k, d]) => [k, d.weight])),
  epsilon: 0.03,            // neutral band on the (shrunk) net
  zScale: 2,                // strength = tanh(|z| / zScale)
  minSessions: 10,          // sessions of history before a z-score is trusted
  minPremium: 100000,       // USD: session gross premium below this => signedPremium unavailable
  premiumRef: 500000,       // USD: activity reference until the ticker has its own baseline
  minChainContracts: 500,   // contracts traded below this => cpVolumeZ unavailable
  cpVolShrink: 2000,
  minOIBase: 1000, minOINet: 100, oiShrink: 500,
  evidenceCap: 60,          // fewer than 2 of 3 directional features => watch-only
  untradeableCap: 60, outsideRthCap: 60,
  maxSpreadPct: 0.25, minAtmOI: 500, atmBand: 0.05,
  vwapConflictAtr: 0.25, priceConflictMult: 0.75,
  earningsGateDays: 2,
};

// ---------------------------------------------------------------------------------------------
// chain aggregation (all from REAL fields; availability tracked). Scoring-path work only.
// ---------------------------------------------------------------------------------------------
/** @param {*} chain normalized chain from provider @returns {*} aggregate metrics */
export function aggregateChain(chain, cfg = DEFAULT_OPTIONS_CFG) {
  const cs = (chain && chain.contracts) || [];
  const calls = cs.filter((c) => c.type === 'call');
  const puts = cs.filter((c) => c.type === 'put');
  const spot = chain && chain.underlying && isNum(chain.underlying.price) ? chain.underlying.price : null;
  const fa = (chain && chain.fieldsAvailable) || {};

  const callVol = sum(calls.map((c) => c.volume)), putVol = sum(puts.map((c) => c.volume));
  const callOI = sum(calls.map((c) => c.openInterest)), putOI = sum(puts.map((c) => c.openInterest));
  const totVol = callVol + putVol, totOI = callOI + putOI;
  // display ratios are null (not Infinity) when a side is empty; the scored quantity is the smoothed log ratio below
  const cpVolRatio = putVol > 0 ? callVol / putVol : null;
  const cpOIRatio = putOI > 0 ? callOI / putOI : null;
  const cpVolLog = Math.log((callVol + 1) / (putVol + 1));
  const volOIRatio = totOI > 0 ? totVol / totOI : null;

  let atmIV = null;
  if (spot !== null && fa.iv) {
    const withIV = cs.filter((c) => isNum(c.iv) && isNum(c.strike));
    if (withIV.length) { const nearest = withIV.slice().sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot)).slice(0, 4); atmIV = mean(nearest.map((c) => c.iv)); }
  }

  // GEX from real gamma x OI (dealer long calls, short puts): context only.
  let gex = null, gexByStrike = null;
  if (spot !== null && fa.greeks && fa.oi) {
    gexByStrike = {};
    for (const c of cs) {
      if (!isNum(c.gamma) || !isNum(c.openInterest) || !isNum(c.strike)) continue;
      const g = c.gamma * c.openInterest * 100 * spot * spot * 0.01 * (c.type === 'put' ? -1 : 1);
      gexByStrike[c.strike] = (gexByStrike[c.strike] || 0) + g;
    }
    gex = sum(Object.values(gexByStrike));
  }
  let gammaFlip = null;
  if (gexByStrike) {
    const strikes = Object.keys(gexByStrike).map(Number).sort((a, b) => a - b);
    let cum = 0; for (const k of strikes) { cum += gexByStrike[k]; if (cum >= 0) { gammaFlip = k; break; } }
  }

  // ATM liquidity (gate): median spread and total OI of contracts within atmBand of spot
  let atmSpread = null, atmOI = null;
  if (spot !== null && spot > 0) {
    const atm = cs.filter((c) => isNum(c.strike) && Math.abs(c.strike / spot - 1) <= cfg.atmBand);
    const sp = atm.filter((c) => isNum(c.bid) && isNum(c.ask) && c.ask > 0 && c.ask >= c.bid && isNum(c.mid) && c.mid > 0).map((c) => (c.ask - c.bid) / c.mid);
    atmSpread = fa.quotes ? median(sp) : null;       // no quote field => unknown, not 'tight'
    atmOI = fa.oi ? sum(atm.map((c) => c.openInterest)) : null;
  }
  let avgSpread = null;
  if (fa.quotes) { const sp = cs.filter((c) => isNum(c.bid) && isNum(c.ask) && c.ask > 0 && c.mid > 0).map((c) => (c.ask - c.bid) / c.mid); avgSpread = median(sp); }

  const strikeOI = {}; for (const c of cs) if (isNum(c.strike) && isNum(c.openInterest)) strikeOI[c.strike] = (strikeOI[c.strike] || 0) + c.openInterest;
  const strikeConcentration = hhi(Object.values(strikeOI));

  return {
    spot, calls: calls.length, puts: puts.length, callVol, putVol, callOI, putOI, totVol, totOI,
    cpVolRatio, cpOIRatio, cpVolLog, volOIRatio, atmIV, gex, gammaFlip, avgSpread, atmSpread, atmOI, strikeConcentration,
    fieldsAvailable: fa,
  };
}

/** Max pain (O(n^2)). DISPLAY ONLY: not part of scoring. Prefer UW /max-pain; this is the chain-derived fallback. */
export function computeMaxPain(chain) {
  const cs = ((chain && chain.contracts) || []).filter((c) => isNum(c.strike) && isNum(c.openInterest));
  if (!cs.length) return null;
  const strikes = [...new Set(cs.map((c) => c.strike))].sort((a, b) => a - b);
  let best = null;
  for (const K of strikes) {
    let pay = 0;
    for (const c of cs) pay += c.type === 'call' ? Math.max(0, K - c.strike) * c.openInterest : Math.max(0, c.strike - K) * c.openInterest;
    if (best === null || pay < best.pay) best = { K, pay };
  }
  return best ? best.K : null;
}

// ---------------------------------------------------------------------------------------------
// features
// ---------------------------------------------------------------------------------------------
const feat = (key, avail, dir, strength, value, note, extra = {}) => ({
  key, label: OPTIONS_FEATURE_DEFS[key].name, avail: avail ? 1 : 0, dir: avail ? dir : 0, strength: avail ? clamp(strength || 0, 0, 1) : 0,
  value: avail && isNum(value) ? value : null, note: note || '', source: OPTIONS_FEATURE_DEFS[key].source, ...extra,
});
const tanhStrength = (z, cfg) => Math.tanh(Math.abs(z) / cfg.zScale);
const zOk = (n) => !!(n && n.available && isNum(n.z));

/** Aggressor-signed premium from flow alerts (ask/bid split per trade). Returns null when no usable trades. */
export function signedPremiumFromTrades(trades) {
  let signed = 0, gross = 0, used = 0, skipped = 0;
  for (const t of Array.isArray(trades) ? trades : []) {
    const right = t && (t.right || t.side);
    const ask = t && isNum(t.askPremium) ? t.askPremium : null, bid = t && isNum(t.bidPremium) ? t.bidPremium : null;
    if ((right !== 'call' && right !== 'put') || ask == null || bid == null) { skipped++; continue; }
    signed += (right === 'call' ? 1 : -1) * (ask - bid);
    gross += ask + bid; used++;
  }
  return used ? { signed, gross, used, skipped, source: 'flow-alerts' } : null;
}

/**
 * @param {*} chain normalized chain
 * @param {*} [ctx] { flow:{trades,netPrem}, oiChange:{callOIChange,putOIChange}, norm:{signedPremium,grossPremium,oiChange,cpVolumeLog} }
 * @param {*} [cfg]
 */
export function extractOptionsFeatures(chain, ctx = {}, cfg = DEFAULT_OPTIONS_CFG) {
  const agg = aggregateChain(chain, cfg);
  const norm = ctx.norm || {};
  const features = [];

  // 1) signedPremium
  {
    let sp = signedPremiumFromTrades(ctx.flow && ctx.flow.trades);
    if ((!sp || sp.gross < cfg.minPremium) && ctx.flow && ctx.flow.netPrem && isNum(ctx.flow.netPrem.callNet) && isNum(ctx.flow.netPrem.putNet)) {
      const c = ctx.flow.netPrem.callNet, p = ctx.flow.netPrem.putNet;
      sp = { signed: c - p, gross: Math.abs(c) + Math.abs(p), used: 0, skipped: 0, source: 'net-prem-ticks' };
    }
    const ok = !!sp && sp.gross >= cfg.minPremium;
    let dir = 0, s = 0, val = null, note = 'no signed flow';
    if (ok) {
      const imb = sp.signed / sp.gross;
      const zn = norm.signedPremium;
      if (zOk(zn) && zn.n >= cfg.minSessions) { dir = sgn(zn.z); s = tanhStrength(zn.z, cfg); val = zn.z; note = `signed premium z=${zn.z.toFixed(2)} (${zn.n} sessions, ${sp.source})`; }
      else { dir = sgn(imb); s = Math.abs(imb); val = imb; note = `signed premium imbalance ${(imb * 100).toFixed(0)}% (raw, no baseline yet, ${sp.source})`; }
      const g = norm.grossPremium;
      const act = (g && g.available !== false && isNum(g.mean) && g.mean > 0 && g.n >= cfg.minSessions) ? sp.gross / g.mean : sp.gross / cfg.premiumRef;
      s *= act / (act + 1);                                     // shrinkage: a thin session cannot produce an extreme reading
    } else if (sp) note = `session premium $${Math.round(sp.gross)} below the $${cfg.minPremium} floor`;
    features.push(feat('signedPremium', ok, dir, s, val, note, { signedPremium: ok ? Math.round(sp.signed) : null, grossPremium: ok ? Math.round(sp.gross) : null, flowSource: sp ? sp.source : null }));
  }
  // 2) oiChange
  {
    const oc = ctx.oiChange;
    let ok = false, dir = 0, s = 0, val = null, note = 'no OI change data';
    if (oc && isNum(oc.callOIChange) && isNum(oc.putOIChange) && isNum(agg.callOI) && isNum(agg.putOI)) {
      const net = oc.callOIChange - oc.putOIChange;
      const prevTotal = agg.callOI + agg.putOI - oc.callOIChange - oc.putOIChange;
      if (prevTotal >= cfg.minOIBase && Math.abs(net) >= cfg.minOINet) {
        ok = true; val = net / prevTotal;
        const zn = norm.oiChange;
        if (zOk(zn) && zn.n >= cfg.minSessions) { dir = sgn(zn.z); s = tanhStrength(zn.z, cfg); note = `OI change z=${zn.z.toFixed(2)} (${zn.n} sessions)`; }
        else { dir = sgn(val); s = clamp(Math.abs(val) / 0.2, 0, 1); note = `net OI change ${(val * 100).toFixed(1)}% of prior OI (raw, no baseline yet)`; }
        s *= Math.abs(net) / (Math.abs(net) + cfg.oiShrink);
      } else note = prevTotal < cfg.minOIBase ? 'prior open interest below the activity floor' : 'net OI change below the activity floor';
    }
    features.push(feat('oiChange', ok, dir, s, val, note));
  }
  // 3) cpVolumeZ: only ever a z-score vs the ticker's own history; raw C/P is never a direction
  {
    const zn = norm.cpVolumeLog;
    const ok = agg.totVol >= cfg.minChainContracts && zOk(zn) && zn.n >= cfg.minSessions;
    let dir = 0, s = 0, val = null, note = 'unavailable until the ticker has enough sessions of volume history';
    if (ok) { dir = sgn(zn.z); s = tanhStrength(zn.z, cfg) * (agg.totVol / (agg.totVol + cfg.cpVolShrink)); val = zn.z; note = `log C/P volume z=${zn.z.toFixed(2)} (${zn.n} sessions)`; }
    else if (agg.totVol < cfg.minChainContracts) note = `only ${agg.totVol} contracts traded (floor ${cfg.minChainContracts})`;
    features.push(feat('cpVolumeZ', ok, dir, s, val, note));
  }
  return { features, agg };
}

// ---------------------------------------------------------------------------------------------
// scoring
// ---------------------------------------------------------------------------------------------
/** @param {*[]} features @param {*} [cfg] */
export function scoreOptions(features, cfg = DEFAULT_OPTIONS_CFG) {
  const w = cfg.weights || DEFAULT_OPTIONS_CFG.weights;
  const totalW = Object.values(w).reduce((a, b) => a + Math.max(0, b), 0) || 1;
  let signed = 0, dirW = 0, availW = 0, nAvail = 0;
  const comps = features.map((f) => {
    const wn = Math.max(0, w[f.key] || 0) / totalW;
    const contribution = wn * f.avail * f.dir * f.strength;
    signed += contribution; availW += wn * f.avail; if (f.avail && f.dir !== 0) dirW += wn; if (f.avail) nAvail++;
    return { ...f, weight: wn, contribution, directional: true };
  });
  const net = dirW > 0 ? signed / dirW : 0;
  const coverage = availW;
  const optionsScore = Math.round(100 * Math.abs(net) * coverage);
  const dir = dirW === 0 ? 'neutral' : net > cfg.epsilon ? 'bull' : net < -cfg.epsilon ? 'bear' : 'neutral';
  return { optionsScore, dir, net, coverage, nAvailable: nAvail, comps };
}

/** Data quality 0..100 from availability of critical fields (informational; not a score multiplier). */
export function dataQualityScore(chain) {
  const fa = (chain && chain.fieldsAvailable) || {};
  const critical = ['chain', 'oi', 'greeks', 'iv', 'quotes', 'underlying'];
  const present = critical.filter((k) => fa[k]).length;
  const status = fa.chain ? (present >= 5 ? 'AVAILABLE' : 'PARTIAL') : 'UNAVAILABLE';
  return { score: Math.round((present / critical.length) * 100), status, present, critical: critical.length, fieldsAvailable: fa };
}

/**
 * Build the production signal. ctx: { flow, oiChange, norm, vwap, atr, now, earningsDaysAway }.
 * `now` (epoch ms / Date) is passed in so the engine stays pure and replayable.
 */
export function buildOptionsSignal(chain, ctx = {}, cfg = {}) {
  const c = { ...DEFAULT_OPTIONS_CFG, ...cfg, weights: { ...DEFAULT_OPTIONS_CFG.weights, ...(cfg.weights || {}) } };
  const dq = dataQualityScore(chain);
  const { features, agg } = extractOptionsFeatures(chain, ctx, c);
  const opt = scoreOptions(features, c);
  const flags = [];
  const gateReasons = [];
  const insufficient = !dq.fieldsAvailable.chain;
  const spot = agg.spot;

  // ---- price gate (replaces the old additive stock term): price vs VWAP in ATR units, RTH only ----
  const vwapDistAtr = (isNum(spot) && isNum(ctx.vwap) && isNum(ctx.atr) && ctx.atr > 0) ? (spot - ctx.vwap) / ctx.atr : null;
  let priceMult = 1, stockConfirm = 0, priceState = 'unavailable';
  if (vwapDistAtr == null) flags.push('PRICE_GATE_UNAVAILABLE');
  else if (opt.dir === 'bull' || opt.dir === 'bear') {
    const aligned = opt.dir === 'bull' ? vwapDistAtr : -vwapDistAtr;      // >0 = price confirms the direction
    if (aligned < -c.vwapConflictAtr) { priceMult = c.priceConflictMult; stockConfirm = -1; priceState = 'conflict'; gateReasons.push('PRICE_CONFLICT'); }
    else if (aligned > c.vwapConflictAtr) { stockConfirm = 1; priceState = 'confirms'; }
    else priceState = 'neutral';
  } else priceState = 'neutral';

  // ---- caps ----
  let cap = 100;
  if (opt.nAvailable < 2) { cap = Math.min(cap, c.evidenceCap); gateReasons.push('INSUFFICIENT_DIRECTIONAL_EVIDENCE'); }
  const spreadBad = isNum(agg.atmSpread) && agg.atmSpread > c.maxSpreadPct;
  const oiBad = isNum(agg.atmOI) && agg.atmOI < c.minAtmOI;
  if (!isNum(agg.atmSpread) && !isNum(agg.atmOI)) flags.push('LIQUIDITY_UNKNOWN');
  const tradeable = !(spreadBad || oiBad);
  if (spreadBad) gateReasons.push('WIDE_ATM_SPREAD');
  if (oiBad) gateReasons.push('LOW_ATM_OI');
  if (!tradeable) cap = Math.min(cap, c.untradeableCap);
  const nowMs = ctx.now instanceof Date ? ctx.now.getTime() : (isNum(ctx.now) ? ctx.now : null);
  const rth = nowMs == null ? null : isRth(nowMs);
  if (rth === null) flags.push('RTH_UNKNOWN');
  const outsideRth = rth === false;
  if (outsideRth) { cap = Math.min(cap, c.outsideRthCap); gateReasons.push('OUTSIDE_RTH'); flags.push('OUTSIDE_RTH'); }

  let score = Math.min(cap, Math.round(opt.optionsScore * priceMult));
  // ---- earnings gate: 0..2 ET days away. rawScore keeps the un-gated value; the published score is 0 ----
  const earn = ctx.earningsDaysAway;
  const gated = isNum(earn) && earn >= 0 && earn <= c.earningsGateDays;
  const rawScore = score;
  if (gated) gateReasons.push('EARNINGS');
  if (!isNum(earn)) flags.push('EARNINGS_UNKNOWN');
  const finalScore = gated ? 0 : score;
  // a price conflict (a down-trending stock against a CALL) can be dampened by x0.75 but is never actionable
  const actionable = !insufficient && !gated && tradeable && !outsideRth && priceState !== 'conflict' && opt.nAvailable >= 2 && (opt.dir === 'bull' || opt.dir === 'bear');

  return {
    ticker: chain && chain.ticker, asOf: chain && chain.asOf, insufficient,
    finalScore, rawScore, gated, tier: scoreTier(finalScore), dir: opt.dir, actionable, tradeable, outsideRth,
    optionsScore: opt.optionsScore, primary: opt.optionsScore,                    // optionsScore = pre-gate evidence score
    net: opt.net, coverage: opt.coverage, availableDirectional: opt.nAvailable,
    stockConfirm, priceGate: { state: priceState, vwapDistAtr: vwapDistAtr == null ? null : Math.round(vwapDistAtr * 100) / 100, multiplier: priceMult },
    gateReasons, flags,
    dataQuality: dq.score, dataQualityStatus: dq.status, dataAvailability: dq.fieldsAvailable,
    features: opt.comps, agg,
    weights: c.weights, optionsEngineVersion: OPTIONS_ENGINE_VERSION,
  };
}

// ---- replay (deterministic; reproduces from a persisted snapshot, no live API) ----
export function captureOptionsSnapshot(chain, ctx, cfg, now) {
  return { optionsEngineVersion: OPTIONS_ENGINE_VERSION, now, ticker: chain && chain.ticker, chain, ctx: ctx || {}, cfg: cfg || {} };
}
export function replayOptionsSignal(snap) { return buildOptionsSignal(snap.chain, { ...(snap.ctx || {}), now: (snap.ctx && snap.ctx.now) ?? snap.now }, snap.cfg || {}); }
