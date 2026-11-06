# AI idea lab

A disciplined way to let an LLM propose ideas on the backfill without fooling ourselves.

- **Language:** ideas are JSON expressions from a fixed whitelist (`research/lab.js`): column lookups, arithmetic, per-ticker causal time-series ops, per-day cross-sectional ranks, filters. The model never runs code and never sees raw data.
- **Three sealed blocks** (frozen in `research-data/lab/splits.json`): explore 40%, validate 30%, vault 30% of days. Labels never cross a block boundary.
- **The model sees explore results only**, plus the number of ideas tried and the current Bonferroni threshold. Validate and vault numbers are never shown to it.
- **Ledger** (`research-data/lab/ledger.jsonl`): every idea ever tried, so the threshold rises honestly with the count.
- **Funnel:** explore (many ideas) -> shortlist (|t| >= 2.5, both halves and "ex-mom1" agree) -> validate (once; same sign and |t| above the Bonferroni bar for the number validated) -> vault (once, guarded by `vault.json`).
- **Cost:** one round is one chat request (about 4k tokens in, 3.5k out). The key is read from `OPENROUTER_API_KEY` and never logged.

Commands: `node scripts/uw-lab.mjs features | info | round | eval | shortlist | validate | vault --yes-open-vault | status`.
