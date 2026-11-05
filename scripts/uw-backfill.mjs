#!/usr/bin/env node
// scripts/uw-backfill.mjs — RUN ON YOUR SERVER (it reads UNUSUAL_WHALES_API_TOKEN from the environment or .env).
//   node scripts/uw-backfill.mjs probe  [TICKER]                       what does my plan allow? (safe to paste back)
//   node scripts/uw-backfill.mjs plan   --file research-data/tickers.txt --days 60     how many calls / how long? (no requests)
//   node scripts/uw-backfill.mjs run    --file research-data/tickers.txt --days 60     download, resumable (re-run to continue)
//   node scripts/uw-backfill.mjs status                                 progress from the manifest
// Options: --tickers A,B,C  --from YYYY-MM-DD --to YYYY-MM-DD  --days N  --endpoints flow,tape,oi,series,market  --rpm 100  --concurrency 1  --out research-data/backfill  --no-gzip (default: files are stored gzip-compressed, *.json.gz)
// The token is never printed or written to disk. Raw responses are stored unchanged and never overwritten.
import fs from 'node:fs';
import path from 'node:path';
import { loadEnvFile } from '../lib/env.js';
import { tradingDays, buildPlan, runBackfill, probe, summarize, DEFAULT_ENDPOINTS } from '../research/backfill.js';

loadEnvFile(path.join(process.cwd(), '.env'), process.env, fs);
const [cmd = 'help', ...rest] = process.argv.slice(2);
const flags = {}; const pos = [];
for (let i = 0; i < rest.length; i++) { if (rest[i].startsWith('--')) flags[rest[i].slice(2)] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : 'true'; else pos.push(rest[i]); }

const token = process.env.UNUSUAL_WHALES_API_TOKEN;
const base = (process.env.OPTIONS_BASE_URL || 'https://api.unusualwhales.com').replace(/\/$/, '');
const out = flags.out || path.join('research-data', 'backfill');
const rpm = Number(flags.rpm || process.env.UW_MAX_PER_MINUTE || 100);
const todayEt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const shift = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const need = () => { if (!token) { console.error('Set UNUSUAL_WHALES_API_TOKEN (or run from the folder that holds .env).'); process.exit(1); } };

function tickers() {
  let list = [];
  if (flags.tickers) list = flags.tickers.split(/[\s,;]+/);
  else { const f = flags.file || path.join('research-data', 'tickers.txt'); if (fs.existsSync(f)) list = fs.readFileSync(f, 'utf8').split(/[\s,;]+/); }
  return [...new Set(list.map((x) => x.trim().toUpperCase()).filter((x) => /^[A-Z][A-Z0-9.\-]{0,9}$/.test(x)))];
}
function jobs() {
  const to = flags.to || shift(todayEt, -1);                    // yesterday: today's data is still incomplete
  const from = flags.from || shift(to, -Number(flags.days || 30));
  const endpoints = flags.endpoints ? flags.endpoints.split(',') : DEFAULT_ENDPOINTS;
  const t = tickers(); if (!t.length) { console.error('No tickers: pass --tickers A,B or --file path.'); process.exit(1); }
  return { t, from, to, endpoints, list: buildPlan({ tickers: t, dates: tradingDays(from, to), endpoints }) };
}

if (cmd === 'probe') {
  need();
  const tk = (pos[0] || 'AAPL').toUpperCase();
  const dates = [1, 5, 30, 90, 180, 365, 540, 700].map((n) => shift(todayEt, -n));
  console.log(`UW backfill probe — ${tk} — ${new Date().toISOString()}\n(net-prem-ticks at increasing age: where it flips to 403 is your real history limit)\n`);
  console.log(await probe({ base, token, ticker: tk, dates }));
} else if (cmd === 'plan') {
  const { t, from, to, endpoints, list } = jobs();
  const minutes = Math.round(list.length / rpm);
  console.log(`${t.length} tickers, ${from}..${to}, endpoints=${endpoints.join(',')}\n${list.length} requests (flow days may page: up to 15x), ~${Math.floor(minutes / 60)}h ${minutes % 60}m at ${rpm}/min\nOutput: ${out}`);
} else if (cmd === 'run') {
  need();
  const { t, from, to, list } = jobs();
  console.log(`Backfilling ${t.length} tickers, ${from}..${to}, ${list.length} requests at ${rpm}/min → ${out}\nSafe to stop (Ctrl+C) and re-run: finished files are skipped.`);
  const stats = await runBackfill({ jobs: list, out, base, token, rpm, concurrency: Number(flags.concurrency || 1), gzip: !flags['no-gzip'], log: (m) => console.log(m) });
  console.log('\nDone.\n' + Object.entries(stats).map(([k, s]) => `${k.padEnd(12)} ok=${s.ok} empty=${s.empty} skipped=${s.skipped} error=${s.error} history-limit=${s.limit}`).join('\n'));
} else if (cmd === 'status') {
  console.log(summarize(out));
} else {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 11).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
}
