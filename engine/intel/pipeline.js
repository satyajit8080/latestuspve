// engine/intel/pipeline.js — screen (1 call/ticker) -> analyze (deep, ~12 calls/ticker) -> scan the universe.
// Missing endpoints leave their family unscored and are listed in dataQuality; nothing is fabricated or defaulted.
import fs from 'node:fs';
import path from 'node:path';
import { normFlow, latestSession, normTape, normOi, normGexLevels, normGreek, normIvRank, normTerm, normSkew, normBars1d, normBars5m, normContracts, normInfo } from './normalize.js';
import { flowFeatures, tapeFeatures, oiFeatures, gexFeatures, priceFeatures, volFeatures, liquidityFeatures, greeksSummary, oiHeatmap, round } from './features.js';
import { evaluate } from './score.js';
import { levelsFor } from './levels.js';
import { explain } from './explain.js';
import { sessionOf, dataMode } from './session.js';
import { ENGINE_VERSION } from './endpoints.js';
import { etDate } from '../../lib/time.js';
import { writeLatest, writeDeep, writeSnapshot } from '../../store/intel-store.js';
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const shiftDay = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

export async function screenTicker(adapter, ticker, { nowMs = Date.now() } = {}) {
  const r = await adapter.fetch('flow', ticker); if (!r.ok) return { ticker, error: r.error, rateLimited: !!r.rateLimited };
  const alerts = normFlow(r.json); const { date, alerts: sess } = latestSession(alerts); const F = flowFeatures(sess);
  if (!F) return { ticker, quiet: true, sessionDate: date, retrievedAt: r.retrievedAt, alerts: [] };
  const activity = Math.log10(1 + F.totalPremium) * (0.5 + Math.abs(F.imbalance ?? 0));
  return { ticker, deep: false, sessionDate: date, retrievedAt: r.retrievedAt, price: F.spot, sector: F.sector, marketCap: F.marketCap, totalPremium: F.totalPremium, callPremium: F.callPremium, putPremium: F.putPremium, imbalance: round(F.imbalance), openingShare: round(F.openingShare), sweepShare: round(F.sweepShare), multiLegShare: round(F.multiLegShare),
    unusualCount: F.unusualCount, nAlerts: F.n, lastAlertAt: F.lastAlertAt, daysToEarnings: F.daysToEarnings, activity: round(activity, 3), alerts: sess, schemaMissing: r.schemaMissing };
}

export async function analyzeTicker(adapter, ticker, { nowMs = Date.now(), prefetchedFlow = null, experimental = false } = {}) {
  const session = sessionOf(nowMs); const today = etDate(nowMs); const q = {}; const dq = {};
  const get = async (key, ...args) => { const r = await adapter.fetch(key, ...args); dq[key] = { ok: r.ok, rows: r.rows ?? 0, error: r.error || null, schemaMissing: r.schemaMissing || [], verified: r.verified }; q[key] = r; return r; };
  const flowRes = prefetchedFlow ? { ok: true, json: prefetchedFlow, rows: 1, retrievedAt: nowMs } : await get('flow', ticker); if (prefetchedFlow) { dq.flow = { ok: true, rows: 1, error: null, schemaMissing: [], verified: true }; }
  await Promise.all(['tape', 'oi', 'greek', 'ivRank', 'term', 'skew', 'bars1d', 'bars5m', 'contracts', 'info'].map((k) => get(k, ticker)));
  let lv = await get('gexLevels', ticker); let levels = lv.ok ? normGexLevels(lv.json) : null; if (!levels) { lv = await get('gexLevels', ticker, shiftDay(today, session === 'open' ? -1 : 0)); levels = lv.ok ? normGexLevels(lv.json) : null; }
  const alerts = flowRes.ok ? normFlow(flowRes.json) : []; const sess = latestSession(alerts); const flow = flowFeatures(sess.alerts); const tape = q.tape.ok ? tapeFeatures(normTape(q.tape.json), { nowMs }) : null;
  const oiC = q.oi.ok ? normOi(q.oi.json) : []; const oi = oiFeatures(oiC); const price = priceFeatures({ bars1d: q.bars1d.ok ? normBars1d(q.bars1d.json) : [], bars5m: q.bars5m.ok ? normBars5m(q.bars5m.json) : { bars: [] }, nowMs, session });
  const gex = gexFeatures({ levels, greek: q.greek.ok ? normGreek(q.greek.json) : [], price: price ? price.price : (flow ? flow.spot : null) });
  const vol = volFeatures({ iv: q.ivRank.ok ? normIvRank(q.ivRank.json) : null, term: q.term.ok ? normTerm(q.term.json) : [], skew: q.skew.ok ? normSkew(q.skew.json) : [], rv20: price ? price.rv20 : null });
  const contracts = q.contracts.ok ? normContracts(q.contracts.json, nowMs) : []; const liquidity = liquidityFeatures(contracts); const info = q.info.ok ? normInfo(q.info.json) : null;
  const f = { flow, tape, oi, gex, price, vol, liquidity }; const ev = evaluate(f); const dirForLevels = ev.direction || (ev.bull.score >= ev.bear.score ? 'bull' : 'bear'); const lv2 = levelsFor(f, dirForLevels); const ex = explain(f, ev, lv2);
  let exp = null; if (experimental) { const [ml, st] = await Promise.all([adapter.fetch('multiLeg', ticker), adapter.fetch('optionStance', ticker)]); exp = { multiLeg: { ok: ml.ok, error: ml.error || null, rows: ml.json ? (Array.isArray(ml.json) ? ml.json : (ml.json.data || [])).slice(0, 50) : [] }, optionStance: { ok: st.ok, error: st.error || null, data: st.ok ? st.json : null }, note: 'Experimental: these endpoint paths come from documentation we could not verify live. They never affect a score.' }; }
  const asOf = price && price.asOf ? price.asOf : (flow ? flow.lastAlertAt : null); const top = ev.direction ? ev[ev.direction] : (ev.bull.score >= ev.bear.score ? ev.bull : ev.bear);
  const row = { ticker, deep: true, name: info ? info.name : null, sector: (info && info.sector) || (flow && flow.sector) || null, marketCap: (info && info.marketCap) || (flow && flow.marketCap) || null, price: price ? round(price.price, 2) : (flow ? flow.spot : null), chgPct: price ? round(price.chgPct) : null,
    state: ev.state, direction: ev.direction, score: top.score, bullScore: ev.bull.score, bearScore: ev.bear.score, reasons: ev.reasons, imbalance: flow ? round(flow.imbalance) : null, callPremium: flow ? flow.callPremium : null, putPremium: flow ? flow.putPremium : null, totalPremium: flow ? flow.totalPremium : null, openingShare: flow ? round(flow.openingShare) : null, sweepShare: flow ? round(flow.sweepShare) : null,
    unusualCount: flow ? flow.unusualCount : null, nAlerts: flow ? flow.n : 0, regime: gex ? gex.regime : null, netGamma: gex ? gex.netGamma : null, gammaFlip: gex ? gex.gammaFlip : null, callWall: gex ? gex.callWall : null, putWall: gex ? gex.putWall : null, gexApproaching: gex ? gex.approaching : [], ivRank: vol ? round(vol.ivRank, 1) : null, iv: vol ? round(vol.iv) : null, rv20: vol ? round(vol.rv20) : null, termSlope: vol ? round(vol.termSlope) : null, impliedMovePct: vol ? round(vol.impliedMovePct) : null, rr25: vol ? round(vol.rr25) : null,
    rvol: price ? round(price.rvol, 2) : null, vsVwapPct: price ? round(price.vsVwapPct) : null, liquidity: liquidity ? liquidity.level : null, atmSpreadPct: liquidity ? round(liquidity.atmSpreadPct) : null, oiImbalance: oi ? round(oi.imbalance) : null, oiCallChange: oi ? oi.callChange : null, oiPutChange: oi ? oi.putChange : null, volOiHits: oi ? oi.volOiHits : null, daysToEarnings: flow ? flow.daysToEarnings : null,
    support: lv2 ? (lv2.support[0] || null) : null, resistance: lv2 ? (lv2.resistance[0] || null) : null, target1: lv2 && lv2.targets[0] ? lv2.targets[0] : null, invalidation: lv2 ? lv2.invalidation : null, riskReward: lv2 ? lv2.riskReward : null, lastAlertAt: flow ? flow.lastAlertAt : null, signalAt: nowMs, retrievedAt: nowMs, asOf, mode: dataMode({ nowMs, asOfMs: nowMs }), why: ex.why.slice(0, 3) };
  const detail = { ...row, version: { engine: ENGINE_VERSION, score: ev.version }, evaluation: { state: ev.state, direction: ev.direction, reasons: ev.reasons, bull: ev.bull, bear: ev.bear }, levels: lv2, explanation: ex, features: { flow: flow && { ...flow, topPrints: flow.topPrints }, tape: tape && { ...tape }, oi, gex, vol, liquidity, price: price && { ...price } }, greeks: greeksSummary(contracts), oiHeatmap: oiHeatmap(oiC, price ? price.price : null), alerts: sess.alerts.slice(-120), sessionDate: sess.date,
    dataQuality: { endpoints: dq, missing: ex.missing, levelsAsOf: gex ? gex.levelsAsOf : null }, experimental: exp };
  return { row, detail };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function runIntelScan({ adapter, universe, deepN = 60, minPremium = 300000, outDir, nowMs = Date.now(), concurrency = 6, deepConcurrency = 3, log = () => {}, writeEvery = 10, keepSnapshot = true }) {
  const started = Date.now(); const rows = []; const flowOf = new Map(); let done = 0, errors = 0, rateLimited = 0, stop = false; const total = universe.length; const schema = {};
  const note = (key, miss) => { if (miss && miss.length) schema[key] = [...new Set([...(schema[key] || []), ...miss])]; };
  const base = () => ({ generatedAt: new Date(nowMs).toISOString(), engine: ENGINE_VERSION, universe: total, deepN, session: sessionOf(nowMs), done, total, errors, schemaWarnings: schema, api: adapter.stats ? adapter.stats() : null });
  const write = (partial, stage) => writeLatest(outDir, { ...base(), partial, stage, mode: dataMode({ nowMs, asOfMs: nowMs }), rows: rows.map(({ alerts, ...r }) => r) });
  let next = 0;
  async function w1() {
    while (!stop) {
      const i = next++; if (i >= total) return; const t = universe[i]; const r = await screenTicker(adapter, t, { nowMs });
      if (r.error) { errors++; if (r.rateLimited && ++rateLimited >= 8) { stop = true; log(`stopping early: repeated rate limits after ${done + 1}/${total}`); } rows.push({ ticker: t, error: r.error }); } else { if (r.alerts && r.alerts.length) flowOf.set(t, r.alerts); note('flow', r.schemaMissing); const { alerts, ...rest } = r; rows.push(rest); }
      done++; if (done % writeEvery === 0 || done === total) { log(`${done}/${total} screened · ${Math.round((Date.now() - started) / 1000)}s`); try { write(true, 'screen'); } catch { /* retried at the end */ } }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, w1));
  const cand = rows.filter((r) => isNum(r.activity) && r.totalPremium >= minPremium); const half = Math.ceil(deepN / 2);
  const pos = cand.filter((r) => r.imbalance > 0).sort((a, b) => b.activity - a.activity), neg = cand.filter((r) => r.imbalance <= 0).sort((a, b) => b.activity - a.activity);
  let pick = [...pos.slice(0, half), ...neg.slice(0, half)]; if (pick.length < deepN) pick = [...pick, ...cand.filter((r) => !pick.includes(r)).sort((a, b) => b.activity - a.activity).slice(0, deepN - pick.length)];
  let di = 0, deepDone = 0; const deepRows = new Map();
  async function w2() {
    while (!stop) {
      const i = di++; if (i >= pick.length) return; const t = pick[i].ticker;
      try { const { row, detail } = await analyzeTicker(adapter, t, { nowMs, prefetchedFlow: { data: (flowOf.get(t) || []).map(denorm) } }); deepRows.set(t, row); writeDeep(outDir, t, detail); for (const [k, v] of Object.entries(detail.dataQuality.endpoints)) note(k, v.schemaMissing); }
      catch (e) { errors++; log(`deep ${t} failed: ${String(e.message).slice(0, 120)}`); }
      deepDone++; if (deepDone % 5 === 0 || deepDone === pick.length) { log(`deep ${deepDone}/${pick.length}`); for (let j = 0; j < rows.length; j++) if (deepRows.has(rows[j].ticker)) rows[j] = deepRows.get(rows[j].ticker); try { write(true, 'deep'); } catch { /* retried */ } }
    }
  }
  await Promise.all(Array.from({ length: deepConcurrency }, w2));
  for (let j = 0; j < rows.length; j++) if (deepRows.has(rows[j].ticker)) rows[j] = deepRows.get(rows[j].ticker);
  rows.sort((a, b) => (b.deep ? b.score : -1) - (a.deep ? a.score : -1) || (b.activity ?? 0) - (a.activity ?? 0)); done = total;
  const out = { ...base(), partial: false, stage: 'done', mode: dataMode({ nowMs, asOfMs: nowMs }), rows: rows.map(({ alerts, ...r }) => r) }; writeLatest(outDir, out); if (keepSnapshot) writeSnapshot(outDir, out, nowMs);
  return { total, screened: rows.filter((r) => !r.error).length, deep: deepRows.size, errors, seconds: Math.round((Date.now() - started) / 1000), schemaWarnings: schema };
}
// the screen stage stores normalized alerts; the deep stage re-uses them as a raw-shaped payload so no flow call is repeated
function denorm(a) { return { created_at: a.ts ? new Date(a.ts).toISOString() : null, type: a.right, strike: a.strike, expiry: a.expiry, total_premium: a.premium, total_ask_side_prem: a.askPrem, total_bid_side_prem: a.bidPrem, volume: a.volume, open_interest: a.openInterest, volume_oi_ratio: a.volOi, total_size: a.size, trade_count: a.trades, has_sweep: a.sweep, has_floor: a.floor, has_multileg: a.multileg, all_opening_trades: a.opening, alert_rule: a.rule, underlying_price: a.spot, delta: a.delta, next_earnings_date: a.nextEarnings, marketcap: a.marketCap, sector: a.sector, option_chain: a.contract, id: a.id }; }
