# research/

Offline and manual tools. The server never imports anything from this folder.

- `scan-universe.js` - manual "Run Scan": calls the shared pipeline (`engine/pipeline.js`) for the UW screener universe and writes `research-data/scan/latest.json`.
- `resolve-outcomes.js` - manual "Resolve Outcomes": appends 15m/30m/60m/close outcome patches to journal records using UW intraday bars (no look-ahead; a checkpoint is never resolved before its wall-clock time).
- `labeler.js`, `validate.js`, `stats.js`, `dataset.js` - walk-forward evaluation utilities (purge and embargo, bootstrap CIs, score buckets).

`research-data/` is git-ignored. Respect your UW rate limits (`UW_MAX_PER_MINUTE`, `UW_MAX_PER_SCAN`).
