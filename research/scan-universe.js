// @ts-check
/*
 * research/scan-universe.js — builds the /signals display cache. For the active options universe
 * (UW screener) it runs the SAME pipeline as the server (engine/pipeline.js: production score + v2 shadow),
 * then writes one JSON snapshot that GET /api/signals/us serves instantly. Manual only (Run Scan).
 * Missing UW fields stay null — nothing faked.
 *
 *   SCAN_DIR=./research-data/scan SCAN_LIMIT=500 node research/scan-universe.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { crossSectionalRank } from '../engine/context.js';
import { createPipelineContext, computeTickerSignal } from '../engine/pipeline.js';
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const g = (o, ...ks) => { let v = o; for (const k of ks) { if (v == null) return null; v = v[k]; } return v == null ? null : v; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOT = path.resolve(new URL('..', import.meta.url).pathname);

// ---- honest derivations (documented; never a probability of profit) ----
function marketBias(score, dir) {
  if (!isNum(score)) return 'UNAVAILABLE';
  if (score >= 80) return 'STRONG';
  if (score >= 65) return dir === 'bull' ? 'BULLISH' : dir === 'bear' ? 'BEARISH' : 'WATCH';
  if (score >= 50) return 'WATCH';
  if (score >= 35) return 'WEAK';
  return 'AVOID';
}
function signalFrom(score, dir) {
  if (!isNum(score)) return 'DATA UNAVAILABLE';
  if (score < 65) return 'WATCH';
  return dir === 'bull' ? 'CALL' : dir === 'bear' ? 'PUT' : 'WATCH';
}
function liquidityBucket(chain) {
  const rows = (chain && chain.contracts) || [];
  let vol = 0, oi = 0; for (const c of rows) { if (isNum(c.volume)) vol += c.volume; if (isNum(c.openInterest)) oi += c.openInterest; }
  if (!rows.length) return null;                       // unavailable
  const liq = vol + oi;
  return liq >= 200000 ? 'HIGH' : liq >= 40000 ? 'MED' : 'LOW';
}
function relativeVolume(ohlc, todayVol) {
  const bars = (ohlc && ohlc.bars) || (Array.isArray(ohlc) ? ohlc : []);
  const vols = bars.map((b) => b.volume).filter(isNum); if (vols.length < 5 || !isNum(todayVol)) return null;
  const avg = vols.slice(-20).reduce((s, x) => s + x, 0) / Math.min(20, vols.length);
  return avg > 0 ? Math.round((todayVol / avg) * 100) / 100 : null;
}

export async function computeRow(P, ticker, opt) {
  const { sectorMap = {}, ctx } = opt;
  // The SAME pipeline the server uses (engine/pipeline.js): identical production + v2 output for the same UW payload.
  const r = await computeTickerSignal(P, ticker, ctx, { gap: opt.gap, now: opt.now });
  if (!r.ok) { const e = new Error(r.detail || r.error || r.reason || 'no chain'); if (r.rateLimited) e.rateLimited = true; throw e; }
  const { signal: sig, chain, v2, extras } = r;
  const price = g(chain, 'underlying', 'price');
  const productionScore = g(sig, 'finalScore');
  const dir = g(sig, 'dir') || 'neutral';
  const oiChange = extras.oiChange;
  return {
    ticker, sector: sectorMap[ticker] || null,
    productionScore, signal: signalFrom(productionScore, dir), marketBias: marketBias(productionScore, dir), dir,
    confidence: g(sig, 'dataQuality'),                  // data/conviction (0-100) — NOT a probability of profit
    price, changePct: extras.changePct, volume: g(chain, 'underlying', 'volume'),
    oiChangeNet: (oiChange && oiChange.available) ? oiChange.netOIChange : null,
    v2Score: v2 && v2.available ? v2.score : null, v2Dir: v2 && v2.available ? v2.dir : null, v2Coverage: v2 && v2.available ? v2.coverage : null,
    vwap: extras.vwap, vsVwapPct: extras.vsVwapPct,
    relativeVolume: relativeVolume(extras.ohlc, g(chain, 'underlying', 'volume')),
    ivRank: g(sig, 'ivRank'), optionsLiquidity: liquidityBucket(chain),
    dataQuality: g(sig, 'dataQuality'), tier: g(sig, 'tier'),
    updatedAt: new Date().toISOString(),
  };
}

export async function main() {
  const key = process.env.OPTIONS_API_KEY || process.env.UNUSUAL_WHALES_API_TOKEN;
  const dir = process.env.SCAN_DIR || path.join(ROOT, 'research-data', 'scan');
  const limit = Math.max(1, Math.min(500, Number(process.env.SCAN_LIMIT || 500)));   // universe size (UW screener cap)
  const gap = Number(process.env.SCAN_GAP_MS || 400);
  if (!key) { console.error('OPTIONS_API_KEY required.'); process.exit(1); }
  fs.mkdirSync(dir, { recursive: true });

  const { makeOptionsProvider } = await import('../providers/options.js');
  const { RateLimiter } = await import('../store/readiness.js');
  // Same rate-limit gate the server uses: honours UW x-ratelimit-* headers, dedupes in-flight
  // calls, backs off on 429/5xx, and stops the scan cold when the daily quota is gone (spec §7).
  const limiter = new RateLimiter({
    maxPerMinute: Number(process.env.UW_MAX_PER_MINUTE) || 110,
    maxPerScan: Number(process.env.UW_MAX_PER_SCAN) || 12000,
  });
  limiter.beginScan();
  const P = makeOptionsProvider(process.env, { limiter });
  if (P.name === 'null') { console.error(P.reason || 'No options provider configured'); process.exit(1); }
  const ctx = createPipelineContext(P, { dailyDir: dir });   // daily-static data shared via files under SCAN_DIR

  let screener = { rows: [] }; try { screener = await P.getScreener({ range: '1d', limit }); } catch (e) { console.error('screener failed:', e.message); }
  const tickers = (screener.rows || []).map((r) => r.ticker).filter(Boolean).slice(0, limit);
  if (!tickers.length) { console.error('empty universe from /screener (warming or off-hours) — wrote nothing.'); process.exit(0); }
  let sectorMap = {}; try { sectorMap = await P.getCompanies(tickers); sectorMap = Object.fromEntries(Object.entries(sectorMap).map(([k, v]) => [k, v && v.sector])); } catch {}

  let rows = []; let ok = 0, skipped = 0, rateLimited = 0;
  const started = Date.now();
  for (let i = 0; i < tickers.length; i++) {
    const t = tickers[i];
    try { const row = await computeRow(P, t, { sectorMap, gap, ctx }); rows.push(row); if (isNum(row.productionScore)) ok++; else skipped++; }
    catch (e) {
      rows.push({ ticker: t, error: e.message }); skipped++;
      // If UW says the quota is gone, stop early and keep what we have (partial scan) rather
      // than grinding through hundreds of guaranteed failures.
      if (e && (e.rateLimited || /quota exhausted|429/i.test(String(e.message)))) {
        rateLimited++;
        if (rateLimited >= 5) { console.error(`stopping early after ${i + 1}/${tickers.length}: UW quota exhausted`); break; }
      }
    }
    if ((i + 1) % 25 === 0 || i + 1 === tickers.length) {
      const el = Math.round((Date.now() - started) / 1000);
      console.log(`  ${i + 1}/${tickers.length} scanned (${ok} scored, ${skipped} skipped) · ${el}s`);
    }
    await sleep(gap);
  }
  rows.sort((a, b) => (b.productionScore ?? -1) - (a.productionScore ?? -1));
  // spec §23 — cross-sectional rank across the universe each cycle
  let _xs = { available: false };
  try { _xs = crossSectionalRank(rows); if (_xs.available) rows = _xs.ranked; } catch {}

  const uw = limiter.stats();
  const out = { crossSectional: _xs.available ? { universe: _xs.universe, topBullish: _xs.topBullish, topBearish: _xs.topBearish, topDecile: _xs.topDecileTickers } : null, generatedAt: new Date().toISOString(), universe: 'screener', requested: tickers.length, scored: ok, skipped, partial: rateLimited >= 5, uwCalls: uw.requestsThisScan, uwRemaining: uw.uwRemaining, count: rows.length, rows };
  const p = path.join(dir, 'latest.json');
  fs.writeFileSync(p, JSON.stringify(out) + '\n');
  console.log(`scanned ${ok}/${tickers.length} tickers (skipped ${skipped}) · ${uw.requestsThisScan} UW calls${isNum(uw.uwRemaining) ? `, ${uw.uwRemaining} remaining today` : ''} -> ${p}`);
  process.exit(0);
}
// Run only when executed directly (importing computeRow for tests must not start a scan).
import { fileURLToPath } from 'node:url';
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
