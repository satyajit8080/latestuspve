# Options Signal Engine

A US options signal scanner built on **Unusual Whales (UW)** data. A server computes one production score per
ticker (`opt-*`) and, beside it, a shadow challenger (`v2`). A browser dashboard shows the results. Scores are a
ranking/confidence number, **not** a probability of profit, and nothing here is financial advice.

## Run

```bash
cp .env.example .env     # then fill in the values below
npm install
npm start                # http://localhost:4000
npm test                 # Node's built-in runner, no extra dependencies
```

Required in `.env` (the server refuses to start without them):

| Variable | Meaning |
|---|---|
| `UNUSUAL_WHALES_API_TOKEN` | Your UW API token |
| `DASHBOARD_PASSWORD` | Login password, at least 16 characters |
| `SESSION_SECRET` | Random string, at least 32 characters, signs session cookies. Rotate it to log everyone out |

Set `COOKIE_SECURE=true` when serving over HTTPS and `TRUST_PROXY=true` behind a reverse proxy.
Failed logins are throttled per IP.

## What you get

- **Signals** – manual "Run Scan" over the UW screener universe; ranked table (score, v2 shadow score, price, VWAP distance, IV rank).
- **Ticker detail** – feature table, option chain, optional AI explanation, and the v2 shadow panel.
- **Signal Journal** – append-only record of every journaled signal, plus outcome resolution (15m/30m/60m/close), evaluation (rank IC, top-decile precision) and readiness of research features.
- **Status** – engine versions, which engine is published, provider and rate-limit state.

There are no timers or background jobs. Scans and outcome resolution run only when you press the button.

## Principles

1. Missing data stays `null` and is flagged. It never becomes 0, a default direction or a fake ratio.
2. One production scorer. `v2` is a shadow challenger and changes nothing until a person edits `validated/promotion.json`.
3. AI is explain-only and has no research side effects.
4. The journal is append-only. Outcomes are appended patches.
5. No look-ahead: features use only data at or before signal time.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the data flow. Older design documents are in `docs/archive/`.
