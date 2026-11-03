# Architecture

## Data flow

```
Unusual Whales REST
      │  providers/unusualwhales.js   rate-limited, retries inside the dedupe, null on any failure
      ▼
engine/pipeline.js  computeTickerSignal(provider, ticker, ctx, { sideEffects })
      │   ├─ production score  public/options-engine.js   (the published score)
      │   ├─ v2 shadow score   engine/v2.js + features.js  (challenger)
      │   ├─ state machine     engine/state.js
      │   └─ journal row       store/signal-log.js        (only when sideEffects !== false)
      ▼
server.js routes  ◄── also used by ──►  research/scan-universe.js (manual "Run Scan")
```

`computeTickerSignal` is the only place a signal is built. The server routes and the scan call it, so they cannot drift.
`sideEffects:false` (used by the AI layer and display routes) writes nothing: no journal row, no baseline, no state or IV-skew snapshot.
Concurrent builds for the same ticker are coalesced.

## Engines

- **Production (`public/options-engine.js`, version in `OPTIONS_ENGINE_VERSION`)** – the published score.
- **v2 shadow (`engine/v2.js`)** – aggressor-signed, delta-weighted flow normalised per ticker against its own same-time-of-day history; gamma, VWAP, RVOL, market and event context act as gates and multipliers.
- **Promotion** – `validated/promotion.json` is the single switch: `{ primary: "opt" | "v2", approvedBy, approvedAt, evidence }`. Default `"opt"`. `v2` only takes effect if all three approval fields are present. `store/readiness.js promotionGate` only reports eligibility. Nothing in the repo writes the file.

## Data rules

- Provider normalisers return `null` for missing or empty fields. `direction` on flow trades means aggressor side (`ask`/`bid`) only; the call/put sign is applied once, in `signedFlow`.
- Times are America/New_York (`lib/time.js`). Session bars are regular-hours bars of the latest session.
- Daily-static endpoints (GEX, IV rank, OHLC, OI change) are cached per ET trading day, successes only.

## Journal and evaluation

- `store/signal-log.js` appends one immutable record per signal. `research/resolve-outcomes.js` appends outcome patches; `store/journal-store.js` merges them at read time.
- `store/evaluation.js` reports rank IC and top-decile precision per horizon.
- `research/validate.js`, `labeler.js`, `stats.js`, `dataset.js` hold offline walk-forward utilities (purge and embargo). The server never imports `research/`.

## Security

Secrets stay server-side and masked in output. Login is throttled per IP; sessions are HMAC-signed with `SESSION_SECRET`.
