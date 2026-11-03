# Signal journal (`store/signal-log.js`)

Append-only JSONL, one file per ET day under `SIGNAL_LOG_DIR`. Schema version `signal-log-1.1.0`.

- `composite` - published outputs: finalScore, dir, tier, primary, optionsScore, stockScore, dataQuality.
- `scored` (A) - values the production score actually used (chain-computed GEX, ATM IV, C/P ratios, per-feature components).
- `displayedNotScored` (B) - values shown but **not** scored (UW GEX override, gamma flip, walls, IV rank, max pain).
- `entry` / `context` - stock price, entry option price (ATM contract on the signal's side, captured at signal time), VWAP, ATR, RVOL, gamma regime, time bucket.
- `v2` - the shadow challenger's output for the same snapshot. Never affects production.
- `outcomes` - `pending` at write time; patches are appended later by `research/resolve-outcomes.js` and merged at read time. Original fields are never rewritten.

Removed in 1.1.0 (old rows stay readable): `pve{}`, `shadowOnly{}`, `shadowScore`, `forward{}`.
