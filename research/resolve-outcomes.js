#!/usr/bin/env node
// Signal Journal — outcome resolver. RUN ON DEMAND (button or CLI); never on a timer, so it
// only spends provider quota when you ask. Leakage-safe: only uses bars strictly AFTER the
// signal fired, and writes outcomes as append-only patches (originals are never rewritten).
//
//   node research/resolve-outcomes.js            # resolve everything that is due
//   MAX_TICKERS=10 node research/resolve-outcomes.js

import { makeOptionsProvider } from '../providers/options.js';
import { readJournal, appendOutcome, pendingOutcomes, journalDir } from '../store/journal-store.js';
import { computeCheckpoint, CHECKPOINT_MS } from '../store/journal.js';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

async function main() {
  const P = makeOptionsProvider(process.env);
  if (!P || P.name === 'null') { console.error('No options provider configured (set OPTIONS_PROVIDER + token).'); process.exit(1); }

  const dir = journalDir();
  const records = readJournal(dir);
  const due = pendingOutcomes(records, Date.now(), CHECKPOINT_MS);
  if (!due.length) { console.log('nothing due to resolve'); return; }

  // group by ticker so each ticker costs ONE intraday call regardless of how many checkpoints are due
  const byTicker = new Map();
  for (const d of due) { if (!byTicker.has(d.ticker)) byTicker.set(d.ticker, []); byTicker.get(d.ticker).push(d); }
  const max = Number(process.env.MAX_TICKERS) || 50;
  const tickers = [...byTicker.keys()].slice(0, max);

  // SPY once per run: market-adjusted returns need the benchmark over the same window.
  let spyBars = [];
  try { const sp = await P.getIntraday('SPY', { candle: '5m', limit: 300 }); spyBars = (sp && sp.rawBars) ? sp.rawBars : []; } catch { spyBars = []; }

  let resolved = 0, unavailable = 0;
  for (const ticker of tickers) {
    let bars = [];
    try {
      const iv = await P.getIntraday(ticker, { candle: '5m', limit: 300 });
      bars = (iv && iv.rawBars) ? iv.rawBars : [];
      if (!bars.length && iv && iv.available) bars = [];      // provider gave VWAP only
    } catch { bars = []; }

    for (const d of byTicker.get(ticker)) {
      const fired = Date.parse(d.firedAt);
      const end = fired + (CHECKPOINT_MS[d.horizon] || 0);
      // STRICTLY AFTER the signal, up to the checkpoint — no look-ahead, no pre-signal data
      const window = bars.filter((b) => isNum(b.t) && b.t > fired && b.t <= end && isNum(b.price));
      if (!window.length) {
        await appendOutcome(d.id, d.horizon, { status: 'unavailable', reason: 'no intraday bars in window', checkpointAt: d.checkpointAt }, dir);
        unavailable++; continue;
      }
      // benchmark window: the SPY bar covering the signal time, then every bar up to the checkpoint
      const base = spyBars.filter((b) => isNum(b.t) && b.t <= fired && isNum(b.price)).pop();
      const spyWin = spyBars.filter((b) => isNum(b.t) && b.t > fired && b.t <= end && isNum(b.price));
      // direction used for the signed fields: the production call, else the shadow's (shadow-only research rows)
      const dir = (d.dir === 'bull' || d.dir === 'bear') ? d.dir : (d.v2Dir === 'bull' || d.v2Dir === 'bear' ? d.v2Dir : 'bull');
      const oc = computeCheckpoint({
        entryStock: d.entry ? d.entry.stockPrice : null,
        entryOption: d.entry ? d.entry.optionPrice : null,
        bars: window, dir,
        atr: d.atr, entryTs: fired,
        horizonMin: (CHECKPOINT_MS[d.horizon] || 0) / 60000,
        benchmarkBars: base ? [base, ...spyWin] : spyWin,
      });
      await appendOutcome(d.id, d.horizon, { ...oc, checkpointAt: d.checkpointAt, resolvedAt: new Date().toISOString() }, dir);
      if (oc.status === 'resolved') resolved++; else unavailable++;
    }
  }
  console.log(`resolved ${resolved} checkpoint(s), ${unavailable} unavailable, across ${tickers.length} ticker(s) -> ${dir}`);
}

main().catch((e) => { console.error('resolve-outcomes failed:', e.message); process.exit(1); });
