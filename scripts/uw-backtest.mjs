#!/usr/bin/env node
// scripts/uw-backtest.mjs — RUN ON THE SERVER, reads research-data/backfill (works on partially downloaded data too).
//   node scripts/uw-backtest.mjs inspect [TICKER]    show the real field names / one sample per data type (safe to paste)
//   node scripts/uw-backtest.mjs checkprices         do the daily closes match the 5-minute bars? (data-quality check)
//   node scripts/uw-backtest.mjs run --from 2026-01-02 [--to YYYY-MM-DD]     build features, then evaluate, print the report
//   node scripts/uw-backtest.mjs features ...        only build research-data/backtest/features.csv
//   node scripts/uw-backtest.mjs evaluate ...        only evaluate an existing features.csv
// Options: --file research-data/sp500.txt  --dir research-data/backfill  --out research-data/backtest  --h 1,3,5
//          --cutoff 15:30  --min-names 30  --cost-bps 10  --top 12
import fs from 'node:fs';
import path from 'node:path';
import { tradingDays } from '../research/backfill.js';
import { buildFeatures, readFeatures, loadPrices, attachLabels, normalize, evaluate, formatReport, loadJson, rowsOf, compareDailyToBars } from '../research/backtest.js';

const [cmd = 'help', ...rest] = process.argv.slice(2);
const flags = {}; const pos = [];
for (let i = 0; i < rest.length; i++) { if (rest[i].startsWith('--')) flags[rest[i].slice(2)] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : 'true'; else pos.push(rest[i]); }
const dir = flags.dir || path.join('research-data', 'backfill'); const outDir = flags.out || path.join('research-data', 'backtest');
const todayEt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const shift = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const tickers = () => { const f = flags.file || path.join('research-data', 'sp500.txt'); return fs.existsSync(f) ? [...new Set(fs.readFileSync(f, 'utf8').split(/[\s,;]+/).map((x) => x.trim().toUpperCase()).filter(Boolean))] : []; };
const horizons = () => (flags.h || '1,3,5').split(',').map(Number).filter((x) => x > 0);

if (cmd === 'checkprices') {
  const r = compareDailyToBars({ dir, tickers: tickers() }); const pc = (n) => (r.compared ? `${((n / r.compared) * 100).toFixed(1)}%` : 'n/a');
  console.log(`Compared ${r.compared} ticker-days over ${r.tickers} tickers (daily close vs last 5-minute bar at or before 16:00 ET)`);
  console.log(`daily close matches the SAME day's regular close (within 0.3%): ${pc(r.same)}`);
  console.log(`matches the PREVIOUS trading day's close instead:               ${pc(r.prevDay)}`);
  console.log(`matches the NEXT trading day's close instead:                   ${pc(r.nextDay)}`);
  console.log(`matches none:                                                   ${pc(r.other)}`);
  console.log(`median absolute difference: ${r.medianAbsDiffPct == null ? 'n/a' : r.medianAbsDiffPct.toFixed(3) + '%'}`);
  console.log(`market_time values in the daily rows: ${JSON.stringify(r.marketTime)}`);
  console.log('largest differences:'); for (const w of r.worst) console.log(`  ${w.t} ${w.d} daily=${w.daily} bars=${w.bars} diff=${w.diffPct.toFixed(2)}%`);
} else if (cmd === 'inspect') {
  const t = (pos[0] || 'AAPL').toUpperCase();
  const short = (v) => { const s = JSON.stringify(v); return s && s.length > 320 ? `${s.slice(0, 320)}…` : s; };
  for (const [ep, file] of [['flow', null], ['tape', null], ['oi', null], ['chain', null], ['bars5m', null], ['darkpool', null], ['termstructure', null], ['gexlevels-oi', null], ['ohlc1d', 'series'], ['gex', 'series'], ['earnings', 'series']]) {
    const base = path.join(dir, ep, t); let name = file;
    if (!name) { try { name = fs.readdirSync(base).filter((x) => /^\d{4}-/.test(x)).sort().pop()?.replace(/\.json(\.gz)?$/, ''); } catch { name = null; } }
    if (!name) { console.log(`\n${ep}: no files for ${t}`); continue; }
    const j = loadJson(path.join(base, `${name}.json`)); const rows = rowsOf(j); const first = rows[0] || (j && j.data && typeof j.data === 'object' ? j.data : null);
    console.log(`\n${ep} ${t} ${name}: rows=${rows.length}${j && j.meta && j.meta.truncated ? ' (truncated)' : ''}\n  keys: ${first && typeof first === 'object' ? JSON.stringify(Object.keys(first)) : typeof first}\n  sample: ${short(first)}`);
  }
} else if (cmd === 'features' || cmd === 'run' || cmd === 'evaluate') {
  const feats = path.join(outDir, 'features.csv');
  if (cmd !== 'evaluate') {
    const to = flags.to || shift(todayEt, -1); const from = flags.from || shift(to, -90); const tk = tickers();
    if (!tk.length) { console.error('No tickers: run scripts/make-sp500.mjs first or pass --file.'); process.exit(1); }
    console.log(`Building features for ${tk.length} tickers, ${from}..${to}, cutoff ${flags.cutoff || '15:30'} ET`);
    const n = buildFeatures({ dir, tickers: tk, dates: tradingDays(from, to).reverse(), cutoff: flags.cutoff || '15:30', out: feats, log: (m) => console.log(m) });
    console.log(`wrote ${n} rows → ${feats}`);
  }
  if (cmd !== 'features') {
    const rows = readFeatures(feats); const tk = [...new Set(rows.map((r) => r.ticker))]; const hs = horizons();
    const prices = loadPrices(dir, tk); console.log(`loaded prices for ${prices.size}/${tk.length} tickers`);
    const labelled = attachLabels(rows, prices, hs); normalize(labelled);
    const rep = evaluate({ rows: labelled, horizons: hs, minNames: Number(flags['min-names'] || 30), costBps: Number(flags['cost-bps'] || 10) });
    const text = formatReport(rep, { top: Number(flags.top || 12) }); console.log('\n' + text);
    fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(rep, null, 1)); fs.writeFileSync(path.join(outDir, 'report.txt'), text);
    console.log(`saved ${path.join(outDir, 'report.txt')} and report.json`);
  }
} else {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 12).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
}
