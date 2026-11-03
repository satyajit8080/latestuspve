// engine/pipeline.js — the ONE place that turns UW data into a production signal + v2 shadow signal.
// Used by BOTH the server routes and the universe scan, so they cannot drift apart.
//
// computeTickerSignal(provider, ticker, ctx, opts)
//   opts.sideEffects (default true): when false the call is read-only with respect to research state —
//   no journal row, no baseline write, no state-machine advance, no IV-skew snapshot, no prev-flow update.
//   The advisory AI uses sideEffects:false (or the cached last signal) so it can never perturb research data.
import fs from 'node:fs';
import path from 'node:path';
import { buildOptionsSignal } from '../public/options-engine.js';
import { scoreV2, V2_VERSION } from './v2.js';
import { signedFlow } from './features.js';
import { step as stateStep, isActionable } from './state.js';
import { computeRvol, MarketContext, IvSkewTracker, EarningsCalendar, eventFlags } from './context.js';
import { BaselineStore } from '../store/normalize.js';
import { rvolReadiness, ivSkewReadiness, sectorRelativeStrength } from '../store/readiness.js';
import { logSignal } from '../store/signal-log.js';
import { etDate } from '../lib/time.js';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const r2 = (x) => (isNum(x) ? Math.round(x * 100) / 100 : null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const g = (o, ...ks) => { let v = o; for (const k of ks) { if (v == null) return null; v = v[k]; } return v == null ? null : v; };

// Daily-static data (GEX, by-strike GEX, IV rank, OHLC, OI change) changes at most once per ET trading day.
// In-memory by default; pass `dir` to share through files with another process (the scan child).
// Only available:true results are cached — a cached failure would poison the whole day.
export function makeDailyCache({ dir = null } = {}) {
  const mem = new Map();
  return async function daily(ticker, name, fn) {
    const day = etDate(Date.now()); const key = `${day}|${ticker}|${name}`;
    if (mem.has(key)) return mem.get(key);
    let fp = null;
    if (dir) {
      const d = path.join(dir, `daily-${day}`); try { fs.mkdirSync(d, { recursive: true }); } catch { /* ignore */ }
      fp = path.join(d, `${ticker}.${name}.json`);
      try { const hit = JSON.parse(fs.readFileSync(fp, 'utf8')); if (hit && hit.available === true) { mem.set(key, hit); return hit; } } catch { /* miss */ }
    }
    const val = await fn();
    if (val && val.available === true) { mem.set(key, val); if (fp) { try { fs.writeFileSync(fp, JSON.stringify(val)); } catch { /* best effort */ } } }
    return val;
  };
}

// All mutable research state lives here, per process. Keyed by ticker so concurrent tickers never collide.
export function createPipelineContext(provider, { baselines = new BaselineStore(), dailyDir = null } = {}) {
  return {
    provider, baselines,
    daily: makeDailyCache({ dir: dailyDir }),
    v2State: new Map(), v2PrevFlow: new Map(),
    ivSkew: new IvSkewTracker(), earnings: new EarningsCalendar(provider), marketCtx: new MarketContext(provider),
    sectorTide: { data: null, at: 0 },
    readiness: new Map(),      // ticker -> { rvol, ivSkew, sector, at }  (per ticker; never a shared global)
    lastSignals: new Map(),    // ticker -> { signal, chain, v2, at }      (read-only cache for the AI layer)
    inflight: new Map(),       // coalesces identical concurrent builds
  };
}

function atr14(bars) {
  const b = Array.isArray(bars) ? bars.slice(-15) : [];
  if (b.length < 15) return null;
  const trs = [];
  for (let i = 1; i < b.length; i++) { const h = b[i].high, l = b[i].low, pc = b[i - 1].close; if (isNum(h) && isNum(l) && isNum(pc)) trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc))); }
  return trs.length >= 10 ? Math.round((trs.reduce((a, c) => a + c, 0) / trs.length) * 100) / 100 : null;
}

// UW by-strike GEX -> walls + gamma flip (sanity-bounded to 50%-150% of spot; chain noise becomes null, not a bogus level).
export function levelsFromByStrike(byStrike, spot) {
  const ss = (byStrike && byStrike.available && Array.isArray(byStrike.strikes)) ? byStrike.strikes.filter((x) => isNum(x.strike)).sort((a, b) => a.strike - b.strike) : [];
  if (!ss.length) return null;
  let cw = null, cmax = -Infinity, pw = null, pmin = Infinity, cum = 0, flip = null, prevCum = 0, prev = null;
  for (const x of ss) {
    const cg = isNum(x.callGex) ? x.callGex : 0, pg = isNum(x.putGex) ? x.putGex : 0;
    if (cg > cmax) { cmax = cg; cw = x.strike; } if (pg < pmin) { pmin = pg; pw = x.strike; }
    cum += cg + pg;
    if (prev != null && flip == null && ((prevCum <= 0 && cum > 0) || (prevCum >= 0 && cum < 0))) flip = x.strike;
    prevCum = cum; prev = x.strike;
  }
  const near = (v) => isNum(v) && (!isNum(spot) || (spot > 0 && v > spot * 0.5 && v < spot * 1.5));
  return { call: near(cw) ? cw : null, put: near(pw) ? pw : null, gammaFlip: near(flip) ? flip : null };
}

export function computeTickerSignal(provider, ticker, ctx, opts = {}) {
  const sideEffects = opts.sideEffects !== false;
  const key = `${ticker}|${sideEffects ? 1 : 0}`;
  // A read-only request may join an in-flight side-effecting build (same result, effects happen once).
  const joinable = ctx.inflight.get(`${ticker}|1`) || ctx.inflight.get(key);
  if (joinable) return joinable;
  const p = _compute(provider, ticker, ctx, { ...opts, sideEffects }).finally(() => ctx.inflight.delete(key));
  ctx.inflight.set(key, p);
  return p;
}

async function _compute(P, ticker, ctx, { sideEffects, now = new Date(), gap = 0 }) {
  if (!P || P.name === 'null') return { ok: false, error: (P && P.reason) || 'No options provider configured', signal: null, chain: null };
  const dwell = () => (gap ? sleep(gap) : null);
  const nowIso = now.toISOString();
  let c = null; try { c = await P.getChain(ticker, { limit: 250 }); } catch (e) { c = { available: false, error: e.message }; }
  const chain = c && c.chain;
  if (!chain || !Array.isArray(chain.contracts) || chain.contracts.length === 0) {
    const rl = c && c.error && /quota exhausted|429|REFUSED/i.test(String(c.error));
    return { ok: false, status: 'UNAVAILABLE', reason: c && c.error ? 'UW_REQUEST_FAILED' : 'UW_NO_CONTRACTS', rateLimited: !!rl,
      detail: c && c.error ? String(c.error).slice(0, 200) : 'UW returned no option contracts for this ticker', signal: null, chain: null };
  }
  const safe = (fn) => { try { return Promise.resolve(fn()).catch(() => null); } catch { return Promise.resolve(null); } };
  const d = (name, fn) => safe(() => ctx.daily(ticker, name, fn));
  // LIVE (never cached): intraday bars. DAILY-STATIC (cached per ET day): the rest.
  const intraday = P.getIntraday ? await safe(() => P.getIntraday(ticker)) : null; await dwell();
  const ohlc = P.getOhlc ? await d('ohlc', () => P.getOhlc(ticker)) : null;
  const oiChange = P.getOiChange ? await d('oichange', () => P.getOiChange(ticker)) : null;
  const gex = P.getGex ? await d('gex', () => P.getGex(ticker)) : null;
  const byStrike = P.getByStrikeGex ? await d('bystrike', () => P.getByStrikeGex(ticker)) : null;
  const ivRank = P.getIvRank ? await d('ivrank', () => P.getIvRank(ticker)) : null;

  const vwap = intraday && intraday.available && isNum(intraday.vwap) ? intraday.vwap : null;
  const bars = ohlc && ohlc.available && Array.isArray(ohlc.bars) ? ohlc.bars : [];
  const pc = g(chain, 'underlying', 'prevClose'), spot = g(chain, 'underlying', 'price');
  const ref = isNum(vwap) ? vwap : pc;                       // price vs VWAP intraday, previous close when closed
  const hist = (isNum(ref) && ref > 0) ? [ref, ref] : bars.slice(-2).map((b) => b.close).filter(isNum);
  const oc = oiChange && oiChange.available && isNum(oiChange.callOIChange) && isNum(oiChange.putOIChange)
    ? { callOIChange: oiChange.callOIChange, putOIChange: oiChange.putOIChange } : null;

  const sig = buildOptionsSignal(chain, { underlyingHist: hist, flow: chain.flow, oiChange: oc }, {});
  // SIGNAL JOURNAL bucket (A): aggregates the SCORE used, captured BEFORE the display overrides below.
  const a0 = sig.agg || {};
  const scoredAgg = { gex: a0.gex, gammaFlip: a0.gammaFlip, maxPain: a0.maxPain, cpVolRatio: a0.cpVolRatio, cpOIRatio: a0.cpOIRatio, volOIRatio: a0.volOIRatio, atmIV: a0.atmIV, strikeConcentration: a0.strikeConcentration, avgSpread: a0.avgSpread, spot: a0.spot };
  // Display/context overrides (bucket B) — do not change the score.
  if (gex && gex.available) { if (isNum(gex.net_gex)) sig.agg.gex = gex.net_gex; sig.gexSource = 'uw'; }
  const lv = levelsFromByStrike(byStrike, spot);
  if (lv) { sig.agg.gammaFlip = lv.gammaFlip; sig.walls = { call: lv.call, put: lv.put }; }
  else if (gex && gex.available) { if (isNum(gex.gamma_flip)) sig.agg.gammaFlip = gex.gamma_flip; sig.walls = { call: gex.call_wall ?? null, put: gex.put_wall ?? null }; }
  if (ivRank && ivRank.available) { sig.ivRank = ivRank.iv_rank; sig.ivPercentile = ivRank.iv_percentile; }

  // Entry option price: ATM contract on the signal's side, captured now (never back-filled).
  let entryOption = null;
  if (isNum(spot)) {
    const want = sig.dir === 'bull' ? 'call' : 'put';
    const cands = chain.contracts.filter((x) => x && x.type === want && isNum(x.strike) && (isNum(x.bid) || isNum(x.ask) || isNum(x.last)));
    if (cands.length) {
      const atm = cands.reduce((best, x) => (Math.abs(x.strike - spot) < Math.abs(best.strike - spot) ? x : best), cands[0]);
      const mid = (isNum(atm.bid) && isNum(atm.ask)) ? (atm.bid + atm.ask) / 2 : (isNum(atm.last) ? atm.last : null);
      if (isNum(mid)) entryOption = Math.round(mid * 100) / 100;
    }
  }
  const vsVwapPct = (isNum(vwap) && isNum(spot) && vwap > 0) ? r2(((spot - vwap) / vwap) * 100) : null;
  const changePct = (isNum(spot) && isNum(pc) && pc > 0) ? r2(((spot - pc) / pc) * 100) : null;
  const atr = atr14(bars);

  // ---------------- v2 SHADOW (never affects the production score) ----------------
  let v2 = null, v2state = null; const readiness = { rvol: null, ivSkew: null, sector: null, at: nowIso };
  try {
    const trades = chain.flow && Array.isArray(chain.flow.largeTrades) ? chain.flow.largeTrades : [];
    const rawFlow = trades.length ? signedFlow(trades, { spot }) : null;
    let normalized = {};
    if (rawFlow && rawFlow.available) {
      const bag = { deltaWeightedSignedFlow: rawFlow.deltaWeightedSignedFlow, openingDeltaFlow: rawFlow.openingDeltaFlow, flowIntensity: rawFlow.flowIntensity };
      if (sideEffects) normalized = await ctx.baselines.normalizeAndRecord(ticker, bag, nowIso);
      else for (const [f, v] of Object.entries(bag)) normalized[f] = ctx.baselines.normalize(ticker, f, v, nowIso);   // read-only
    }
    const flags = eventFlags(now);
    let rvol = { available: false, rvol: null }, mkt = { spyTrend: null, qqqTrend: null }, ivc = { available: false }, earn = null;
    try { if (intraday) rvol = await computeRvol({ baselines: ctx.baselines, ticker, intraday, at: nowIso, record: sideEffects }); } catch { /* optional */ }
    try { mkt = await ctx.marketCtx.get(); } catch { /* optional */ }
    try { ivc = sideEffects ? ctx.ivSkew.update(ticker, chain.contracts, spot) : ctx.ivSkew.peek(ticker, chain.contracts, spot); } catch { /* optional */ }
    try { earn = await ctx.earnings.daysAway(ticker); } catch { earn = null; }
    let sector = { state: 'UNAVAILABLE' };
    try {
      if (Date.now() - ctx.sectorTide.at > 5 * 60000 && P.getSectorTide) { ctx.sectorTide.data = await P.getSectorTide(); ctx.sectorTide.at = Date.now(); }
      let secName = null; try { const comp = await P.getCompanies([ticker]); secName = comp && comp[ticker] ? comp[ticker].sector : null; } catch { secName = null; }
      sector = sectorRelativeStrength({ ticker, sector: secName, sectorTide: ctx.sectorTide.data, marketTide: null });
    } catch { sector = { state: 'UNAVAILABLE', reason: 'SECTOR_LOOKUP_FAILED' }; }
    readiness.rvol = rvolReadiness({ baselines: ctx.baselines, ticker, bucket: flags.timeBucket, rvolResult: rvol });
    readiness.ivSkew = ivSkewReadiness(ivc); readiness.sector = sector;

    v2 = scoreV2({
      ticker, at: nowIso, trades, normalized, prevFlow: ctx.v2PrevFlow.get(ticker) ?? null,
      spot, vwap, atr, gex: isNum(sig.agg.gex) ? sig.agg.gex : null, gammaFlip: isNum(sig.agg.gammaFlip) ? sig.agg.gammaFlip : null,
      callWall: sig.walls ? sig.walls.call : null, putWall: sig.walls ? sig.walls.put : null,
      previousRegime: (ctx.v2State.get(ticker) || {}).gammaRegime || null,
      rvol: rvol.available ? rvol.rvol : null,
      market: { spyTrend: mkt.spyTrend, qqqTrend: mkt.qqqTrend, sectorTrend: sector.sectorTrend || null, relativeStrength: sector.sectorRelativeStrength ?? null },
      ivChanges: ivc.available ? ivc : {},
      events: { timeBucket: flags.timeBucket, isOpex: flags.isOpex, earningsDaysAway: earn },
      vwapSlope: null, ret5m: null, ret15m: null, ret30m: null,
    });
    if (sideEffects && rawFlow && rawFlow.available) ctx.v2PrevFlow.set(ticker, rawFlow.deltaWeightedSignedFlow);
    if (v2 && v2.available) {
      const prevState = ctx.v2State.get(ticker) || null;
      // read-only calls still show what the state WOULD be, but never store it
      v2state = stateStep(prevState, { score: v2.score, dir: v2.dir, at: nowIso });
      v2state.gammaRegime = v2.gamma && v2.gamma.available ? v2.gamma.regime : null;
      if (sideEffects) ctx.v2State.set(ticker, v2state);
      sig.v2 = { version: V2_VERSION, score: v2.score, dir: v2.dir, state: v2state.state, smoothedScore: v2state.smoothedScore, actionable: isActionable(v2state.state),
        coverage: v2.coverage, components: v2.components, multipliers: v2.multipliers, reasons: v2.reasons, quality: v2.quality, gated: v2.gated,
        note: 'shadow only — production score is unchanged' };
    }
  } catch (e) { sig.v2 = { error: e.message, note: 'shadow path failed; production unaffected' }; }

  if (sideEffects) {
    ctx.readiness.set(ticker, readiness);
    try {
      await logSignal({ ticker, sig, scoredAgg, underlying: chain.underlying || null, prevHadSnapshot: !!oc, now, entryOption, vsVwapPct, changePct, atr, vwap,
        v2: v2 && v2.available ? { version: V2_VERSION, score: v2.score, dir: v2.dir, coverage: v2.coverage, components: v2.components, reasons: v2.reasons, quality: v2.quality, gated: v2.gated } : null,
        flowDetailed: chain.flow || null });
    } catch { /* journaling must never break a build */ }
  }
  const out = { ok: true, signal: sig, chain, v2, v2state, readiness, extras: { vwap, vsVwapPct, changePct, atr, entryOption, oiChange, ohlc, ivRank } };
  ctx.lastSignals.set(ticker, { signal: sig, chain, at: Date.now() });
  return out;
}
