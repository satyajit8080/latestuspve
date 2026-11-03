# PR summary: fix, simplify and improve scoring

Branch `claude/fix-simplify-scoring`, nine commits (one build-order step each). `npm test`: **265 pass, 0 fail, 0 cancelled, about 21 s** (the suite used to hang about 300 s on a deadlock).

## Owner actions (not done by this PR)

1. **Rotate the dashboard password.** The old value is still in git history. Rewriting history (`git filter-repo`) is your call; nothing was force-pushed.
2. **Update `.env` before deploying.** The server now refuses to start without `DASHBOARD_PASSWORD` (16+ chars) and `SESSION_SECRET` (32+ chars). `OPTIONS_API_KEY` is no longer read. Session cookie renamed (`sess`), so everyone is logged out once. AI is off unless `AI_ENABLED=true`.
3. **Check the UW field assumptions against the live API** (see "Not verified" below) with `node scripts/uw-diagnostic.mjs`.

## Bugs fixed (A)

| # | Fix |
|---|---|
| 1 | Limiter retry deadlock: the retry loop now runs inside the deduped call (bounded-time tests for 429/5xx/network). |
| 2 | Put buying counted as bullish: `direction` is aggressor side only (`ask`/`bid`), ask/bid premiums pass through, call/put sign applied once. Sign table tested. |
| 3 | Earnings gate never fired: real provider shape, ET calendar days, blocks only 0..2 days. |
| 4 | v2 price component is `null`, not 0, when VWAP is missing. |
| 5 | State machine: hysteresis replaces the deadband, signed EWMA, BULL→NEUTRAL→BEAR obeys cooldown and flip margin, state resets after `maxGapMs`. |
| 6 | `open_interest_change` removed from the OI alias list; unknown option type skipped, not defaulted to call. |
| 7 | Intraday timestamps parsed before filtering; `sessionBars` = latest ET session, RTH only; VWAP, session volume and RVOL use them. |
| 8 | One `computeTickerSignal` pipeline for the server and the scan; parity tested. |
| 9 | OI change always from UW daily `/oi-change` (cached per ET day); prevAgg reconstruction deleted. |
| 10 | AI reads the cached signal or builds with `sideEffects:false`; HTTP-level test shows journal and baselines byte-identical. |
| 11 | Per-ticker in-flight coalescing, per-ticker readiness, single-ticker UW routes return 409 while a scan runs. |
| 12 | Baselines: one observation per ticker × bucket × ET session, current session excluded from its own baseline, `MIN_HISTORY` counts sessions, v2 flow limited to current-session alerts. |
| 13 | `atmIvChange` null unless all four IVs exist; ATM taken from one expiry ≥ 7 DTE. |
| 14 | `stockConfirm` exposed; production reason codes; stats default `60m`; `avg1hReturn`→`avgReturn`; factor win rate filters on agreement; v2 evaluated with its own direction, gated rows excluded; "65+ threshold" text removed. |
| 15 | Scan daily cache stores successes only and is keyed by ET date. |
| 16 | No `Infinity` C/P ratio (smoothed log ratio); `mean()` of empty is `null`. |
| 17 | Duplicate UW calls removed (second `getUnderlying`, per-poll `/info`, second flow-alerts fetch in `logSignal`). |
| 18 | Max pain is display-only (UW `/max-pain`, chain fallback), outside the scoring path. |

## Security (B)

No literal password anywhere (repo-wide grep test); no escape hatch; per-IP login throttle (5 failures/min, doubling lockout); `COOKIE_SECURE`, `TRUST_PROXY`; cookies signed with `SESSION_SECRET`; `.env` loader strips inline comments; `.env.example` rewritten and tested for unique keys.

## Removed (C)

- Prediction-market layer: `public/engine.js`, `classify.js`, the PVE normalisation/upstream/explore/classify code in `server.js`, PM factor in the engine, journal `pve{}`, PVE UI sections.
- Third engine: `shadow/engine.js`, `shadow/cross-sectional.js`, `/api/shadow/*`, scan shadow columns.
- One promotion path: `validated/model.js` deleted; `validated/promotion.js` + `promotion.json` (`primary: "opt"|"v2"` with `approvedBy`/`approvedAt`/`evidence`). Default `opt`; nothing in the repo writes the file.
- Duplicate research pipelines: `capture-snapshot`, `capture-signals`, `signals-store`, `snapshot-store`, `resolve-forward-returns`, `run-phase3`, `importance`, `signal-log-report`, `technicals`.
- Confidence-by-presence features (`volOIAnomaly`, `ivBehavior`, `gexContext`, `strikeConc`, `liquidity`: 54% of the old weight), `dqFactor`, the additive stock-momentum term, journal `forward{}`.
- UI: rewritten as a thin shell (Signals, Ticker detail, Journal, Status); `overview-sim.js` removed; `public/` holds no scoring math (engine moved to `engine/options-engine.js`).
- Docs: old audits/setup moved to `docs/archive/`; new `README.md` and `docs/ARCHITECTURE.md`.

## Scoring (D): `opt-1.2.0`, `v2-0.2.0`, journal schema `1.2.0`

Direction comes only from `signedPremium` (0.50), `oiChange` (0.25) and `cpVolumeZ` (0.25), each normalised per ticker against its own prior sessions (z-score once ≥ 10 sessions, raw-with-shrinkage before; `cpVolumeZ` is unavailable until then). Score = 100 × |net| × coverage, fewer than 2 of 3 features caps at 60. Price-vs-VWAP (×0.75 on conflict, not actionable), liquidity, RTH and earnings are gates/caps and never add points.
v2: delta from the matching chain contract (unmatched = excluded, flagged, never 0.5), gamma multiplier never rewards conflict (positive 0.85, negative ≤ 1.15 only when price confirms), intraday inputs computed from session bars, not actionable without flow and price.
Journal: every non-neutral scored signal (production or v2) is written, deduped per ticker per 30 min; 70+ is a UI/alert filter. The frozen `opt-1.1.1` score is journaled as `legacy`/`legacyScore` on the same inputs for the transition.
Evaluation: each engine's return signed by its own direction, SPY-adjusted returns, per-timestamp cross-sectional IC with t-stat, one observation per ticker per day for pooled IC, seeded bootstrap CIs, random and momentum-only baselines, ATR scaled by √(horizon/390), records never pooled across engine versions.

## Evaluation numbers

**None yet.** There is no resolved journal (`research-data/signal-log`) in this environment, so the `opt-1.2.0` vs `opt-1.1.1` comparison (≥ 100 deduped resolved 30m observations, mean cross-sectional IC and top-decile precision vs base rate) could not be run. The comparison is wired (`baselineReport` reports both on identical observations) and the weights are therefore **not yet validated**. `promotion.json` stays `primary: "opt"`. Once the data exists: run `baselineReport`, and keep `opt-1.2.0` only if it meets the stated bar, otherwise revert the weights to the closest simple alternative and keep the fixes and cuts. After ~10 sessions of data, delete `legacy/`.

## Not verified / known limits

- **Live UW was never called.** UW payload shapes are mocked from the field names already used in the repo (`created_at`, `option_chain`, `total_ask_side_prem`, `net_call_premium`, `next_earnings_date`). The `net-prem-ticks` fallback assumes net = ask-side minus bid-side per UW's definition.
- v2 state-machine state and the scan child's state are in-memory only (reset on restart / per scan); persistence was out of scope.
- The `close` outcome checkpoint still is not resolved (pre-existing).
- UI checked by a headless-browser smoke test (login, all four tabs, no console errors), not against live data.
