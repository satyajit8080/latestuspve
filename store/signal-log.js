// @ts-check
/*
 * store/signal-log.js — SERVER-SIDE writer for the Signal Journal (event/outcome research dataset).
 * Separate from the scan cache and the Phase-3 signals-store. Append-only JSONL. NOT in public/,
 * NOT in research/ (so the production server can import it without breaking the server→research
 * boundary). Analysis + forward-return resolution live offline in research/ and read these files.
 *
 * GUARANTEES (reqs 6, 9, 10):
 *  - Reads the already-built production signal; NEVER recomputes or changes it.
 *  - Fire-and-forget: every path is wrapped so a logging failure can never break the request.
 *  - Nothing fabricated; unavailable data is written as null / status flags.
 *
 * SOURCE DISTINCTION (req 7) — three explicitly separated buckets per record:
 *   scored[]            (A) values actually used in production scoring (incl. chain-computed GEX)
 *   displayedNotScored  (B) values computed/overridden for display but NOT used in the score
 *                            (UW GEX override, gamma-flip/walls override, IV-rank, max-pain)
 */
import fs from 'node:fs';
import path from 'node:path';
import { OPTIONS_FEATURE_DEFS } from '../engine/options-engine.js';
import { explainSignal, reasonCodes, CHECKPOINTS } from './journal.js';

export const SIGNAL_LOG_SCHEMA = 'signal-log-1.2.0';   // 1.2.0: composite gains rawScore/gated/gates/flags, drops stockScore; legacy{} added. 1.1.0: removed pve{}, shadowOnly{}, shadowScore, forward{}. Old rows stay readable.
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const DIR_KEYS = Object.entries(OPTIONS_FEATURE_DEFS).filter(([, d]) => d.directional).map(([k]) => k);

function logDir() { return process.env.SIGNAL_LOG_DIR || path.join(path.resolve(new URL('..', import.meta.url).pathname), 'research-data', 'signal-log'); }
// spec §12 time buckets, computed in US Eastern from the fire timestamp
function timeBucket(d) {
  try {
    const et = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const m = et.getHours() * 60 + et.getMinutes();
    if (m < 570) return 'premarket';
    if (m < 585) return '09:30-09:45';
    if (m < 630) return '09:45-10:30';
    if (m < 690) return '10:30-11:30';
    if (m < 780) return '11:30-13:00';
    if (m < 870) return '13:00-14:30';
    if (m < 930) return '14:30-15:30';
    if (m <= 960) return '15:30-16:00';
    return 'afterhours';
  } catch { return null; }
}
function bucket30min(d) { const t = d.getTime(); return new Date(Math.floor(t / 1800000) * 1800000).toISOString(); }

// In-memory dedupe: one record per ticker per 30-min bucket, safe across repeated dashboard/scan calls
// in the same process. Deterministic id also lets the offline resolver/report dedupe across restarts.
const _seen = new Map(); // id -> ts
function _dedupe(id) {
  const now = Date.now();
  if (_seen.size > 5000) for (const [k, ts] of _seen) if (now - ts > 900000) _seen.delete(k);
  if (_seen.has(id)) return false;
  _seen.set(id, now); return true;
}

/**
 * Fire-and-forget. Call as: void logSignal({ provider, ticker, sig, scoredAgg, prevHadSnapshot, now }).
 * @param {{provider?:object, ticker:string, sig:object, scoredAgg:object, underlying?:object, prevHadSnapshot?:boolean, now?:Date}} args
 *   scoredAgg = snapshot of sig.agg taken BEFORE the UW gex/iv overrides (so we log the values the
 *   score actually used, immune to the later display override).
 */
export async function logSignal({ ticker, sig, scoredAgg = {}, underlying = null, prevHadSnapshot = false, now, entryOption = null, vsVwapPct = null, changePct = null, atr = null, vwap = null, legacy = null, rvol = null, marketRegime = null, earningsWithin2Days = null, v2 = null } = {}) {
  try {
    if (!sig || !ticker) return;
    // Journal every non-neutral scored signal (production OR v2 shadow) as a research row. Filtering to a minimum
    // score here would restrict the score range and make rank IC across the range unmeasurable; the 70+ cut is a
    // UI/alert filter (JOURNAL_ALERT_MIN), not a write filter.
    const dir = sig.dir;
    const prodOk = dir !== 'neutral' && dir != null && isNum(sig.finalScore);
    const v2Ok = !!(v2 && isNum(v2.score) && (v2.dir === 'bull' || v2.dir === 'bear'));
    if (!prodOk && !v2Ok) return;
    const firedAt = (now instanceof Date ? now : new Date());
    const id = `${String(ticker).toUpperCase()}:${bucket30min(firedAt)}`;
    if (!_dedupe(id)) return;                                   // one row per ticker per 30 minutes

    const a = sig.agg || {};
    const under = underlying && typeof underlying === 'object' ? underlying : null;
    const price = under && isNum(under.price) ? under.price : (isNum(scoredAgg.spot) ? scoredAgg.spot : (isNum(a.spot) ? a.spot : null));

    // (A) production-scored components, verbatim from the engine (captured at scoring time).
    const components = Array.isArray(sig.features) ? sig.features.map((f) => ({
      key: f.key, scored: true, directional: !!(OPTIONS_FEATURE_DEFS[f.key] && OPTIONS_FEATURE_DEFS[f.key].directional),
      weight: OPTIONS_FEATURE_DEFS[f.key] ? OPTIONS_FEATURE_DEFS[f.key].weight : null,
      avail: f.avail, dir: f.dir, strength: f.strength, value: f.value,
    })) : [];
    const activeScored = components.filter((c) => c.directional && c.avail && isNum(c.strength) && c.strength > 0 && (c.dir === 1 && dir === 'bull' || c.dir === -1 && dir === 'bear')).map((c) => c.key);


    const rec = {
      schemaVersion: SIGNAL_LOG_SCHEMA, id, firedAt: firedAt.toISOString(), ticker: String(ticker).toUpperCase(),
      signalType: 'options', optionsEngineVersion: sig.optionsEngineVersion || null,
      composite: {
        finalScore: sig.finalScore, rawScore: isNum(sig.rawScore) ? sig.rawScore : null, gated: !!sig.gated, dir, tier: sig.tier, primary: sig.primary, optionsScore: sig.optionsScore,
        stockConfirm: sig.stockConfirm ?? null, priceGate: sig.priceGate || null, gateReasons: Array.isArray(sig.gateReasons) ? sig.gateReasons : [], flags: Array.isArray(sig.flags) ? sig.flags : [],
        actionable: sig.actionable ?? null, tradeable: sig.tradeable ?? null, coverage: isNum(sig.coverage) ? sig.coverage : null, availableDirectional: sig.availableDirectional ?? null,
        dataQuality: sig.dataQuality, optionsEngineVersion: sig.optionsEngineVersion || null,
      },
      legacy: legacy || null,   // frozen opt-1.1.1 result on the same inputs (transition comparison; see legacy/README.md)
      scored: {                                                 // (A) used in production scoring
        gexChainComputed: isNum(scoredAgg.gex) ? scoredAgg.gex : null,
        atmIV: isNum(scoredAgg.atmIV) ? scoredAgg.atmIV : null,
        cpVolRatio: isNum(scoredAgg.cpVolRatio) ? scoredAgg.cpVolRatio : null,
        cpOIRatio: isNum(scoredAgg.cpOIRatio) ? scoredAgg.cpOIRatio : null,
        volOIRatio: isNum(scoredAgg.volOIRatio) ? scoredAgg.volOIRatio : null,
        strikeConcentration: isNum(scoredAgg.strikeConcentration) ? scoredAgg.strikeConcentration : null,
        avgSpread: isNum(scoredAgg.avgSpread) ? scoredAgg.avgSpread : null,
        oiChangeAvailable: !!prevHadSnapshot,                   // false at cold start (documented)
        components, activeComponents: activeScored,
      },
      displayedNotScored: {                                     // (B) computed/overridden, NOT scored
        gexOverride: isNum(a.gex) ? a.gex : null, gexSource: sig.gexSource || null,
        gammaFlip: isNum(a.gammaFlip) ? a.gammaFlip : null,
        callWall: sig.walls ? (sig.walls.call ?? null) : null, putWall: sig.walls ? (sig.walls.put ?? null) : null,
        ivRank: isNum(sig.ivRank) ? sig.ivRank : null, ivPercentile: isNum(sig.ivPercentile) ? sig.ivPercentile : null,
        maxPain: isNum(a.maxPain) ? a.maxPain : null,
        price: isNum(price) ? price : null,
        prevClose: under && isNum(under.prevClose) ? under.prevClose : null,
      },
      entryPrice: isNum(price) ? price : null,
      // Signal Journal: exact state at generation time (never rewritten by later analysis)
      entry: {
        stockPrice: isNum(price) ? price : null,
        optionPrice: isNum(entryOption) ? entryOption : null,
        vsVwapPct: isNum(vsVwapPct) ? vsVwapPct : null,
        changePct: isNum(changePct) ? changePct : null,
        capturedAt: firedAt.toISOString(),
      },
      // Context captured at signal time (spec §21 signal_context). Unknown => null, never 0.
      context: {
        atr: isNum(atr) ? atr : null,
        vwap: isNum(vwap) ? vwap : null,
        vsVwapPct: isNum(vsVwapPct) ? vsVwapPct : null,
        rvol: isNum(rvol) ? rvol : null,
        gammaRegime: isNum(a.gex) ? (a.gex > 0 ? 'positive' : 'negative') : null,
        gammaFlip: isNum(a.gammaFlip) ? a.gammaFlip : null,
        gammaFlipDistanceAtr: (isNum(a.gammaFlip) && isNum(price) && isNum(atr) && atr > 0) ? Math.round(((price - a.gammaFlip) / atr) * 100) / 100 : null,
        timeOfDayBucket: timeBucket(firedAt),
        marketRegime: marketRegime || null,
        earningsWithin2Days: earningsWithin2Days === true ? true : (earningsWithin2Days === false ? false : null),
        signalVersion: sig.optionsEngineVersion || null,
      },
      outcomes: CHECKPOINTS.reduce((o, h) => { o[h] = { status: 'pending' }; return o; }, {}),
      v2: v2 || null,       // shadow scorer output (spec phases 2-5); never affects production
      postAnalysis: null,   // written only after outcomes resolve; never modifies the fields above
      resolved: false,
    };

    try { rec.explain = explainSignal(rec); } catch { rec.explain = null; }
    try { rec.reasons = reasonCodes(rec); } catch { rec.reasons = []; }   // generated ONCE, from signal-time data only

    const dir_ = logDir();
    await fs.promises.mkdir(dir_, { recursive: true });
    await fs.promises.appendFile(path.join(dir_, `signal-log-${firedAt.toISOString().slice(0, 10)}.jsonl`), JSON.stringify(rec) + '\n');
  } catch { /* req 10: logging must never break the request */ }
}
