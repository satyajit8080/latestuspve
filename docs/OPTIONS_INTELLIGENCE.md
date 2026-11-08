# Options Intelligence

US equities options module (Unusual Whales). Separate from the Indian/DhanHQ code. Keys stay on the backend.

## Completed
- Scanner (2-stage: screen 1 call/ticker, deep ~12 calls for top N), child process, snapshots, data-mode labels (LIVE/DELAYED/CLOSED/HISTORICAL), API status, schema watch.
- Sections: Market Scanner, Unusual Flow, GEX & Gamma Levels, Institutional Positioning, Volatility Intelligence, Top Opportunities, Strategy Backtesting, stock detail page.
- Scoring: 5 evidence families (flow 30, OI 12, GEX 15, price 20, volume 8), one vote per family, every contribution shown, bull/bear separate, modifiers and NO_TRADE gates. Weights are unvalidated priors.
- Strategy Backtesting: rule presets on the 2-year lab panel; win rate, profit factor, avg return, expectancy, max drawdown, Sharpe, regime split (market trend, volatility), costs; train / validation / out-of-sample (OOS opens once per strategy, only if train and validation are net-positive).

## Endpoints
Verified live: flow-alerts, net-prem-ticks, oi-change, gex-levels, greek-exposure, iv-rank, volatility/term-structure, historical-risk-reversal-skew, ohlc, option-contracts, info, darkpool, earnings, market-tide, sector-tide, screener, full-tape.
Experimental (off by default): option-trades/multi-leg, option-stance, greek-exposure/strike.
Run `node scripts/intel-probe.mjs` on the server to re-check.

## Pending / limits
- Nothing here has run against live UW data from the build sandbox; probe on the server first.
- Gamma/IV/term-structure history is ~120 days; backtests using them are short. Snapshots accumulate for later.
- Universe is the current index list (survivorship bias). Costs are a flat estimate.
- UW data must not be redistributed.
