// research/intel-scan.js — Options Intelligence scan job (spawned by the server, or run by hand).
//   INTEL_DEEP_N=60 INTEL_MIN_PREMIUM=300000 node research/intel-scan.js
// Universe: research-data/sp500.txt (or INTEL_UNIVERSE_FILE); falls back to the Unusual Whales screener. Manual only: it spends API quota.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from '../lib/env.js';
import { makeOptionsProvider } from '../providers/options.js';
import { RateLimiter } from '../store/readiness.js';
import { createIntelAdapter } from '../providers/uw-intel.js';
import { runIntelScan } from '../engine/intel/pipeline.js';
import { rowsOf } from '../engine/intel/normalize.js';
import { intelDir } from '../store/intel-store.js';
import { safeTicker } from '../ticker.js';

export async function main(env = process.env) {
  loadEnvFile(path.join(process.cwd(), '.env'), env, fs);
  const limiter = new RateLimiter({ maxPerMinute: Number(env.UW_MAX_PER_MINUTE) || null, maxPerScan: Number(env.UW_MAX_PER_SCAN) || 12000 });
  const provider = makeOptionsProvider(env, { limiter }); if (provider.name === 'null') { console.error(`Options Intelligence needs a provider: ${provider.reason}`); return 2; }
  const adapter = createIntelAdapter(provider); let universe = [];
  const file = env.INTEL_UNIVERSE_FILE || path.join(process.cwd(), 'research-data', 'sp500.txt');
  try { if (fs.existsSync(file)) universe = [...new Set(fs.readFileSync(file, 'utf8').split(/[\s,;]+/).map((x) => safeTicker(x)).filter(Boolean))]; } catch { /* fall back */ }
  if (!universe.length) { const r = await adapter.fetch('screener'); if (r.ok) universe = [...new Set(rowsOf(r.json).map((x) => safeTicker(x.ticker || x.symbol)).filter(Boolean))]; }
  const limit = Math.max(1, Number(env.INTEL_UNIVERSE_LIMIT) || 600); universe = universe.slice(0, limit); if (!universe.length) { console.error('empty universe: no sp500.txt and the screener returned nothing'); return 3; }
  const outDir = intelDir(env); console.log(`Options Intelligence scan: ${universe.length} tickers, deep ${Number(env.INTEL_DEEP_N) || 60} -> ${outDir}`);
  const sum = await runIntelScan({ adapter, universe, deepN: Number(env.INTEL_DEEP_N) || 60, minPremium: Number(env.INTEL_MIN_PREMIUM) || 300000, outDir, concurrency: Math.max(1, Math.min(10, Number(env.INTEL_CONCURRENCY) || 5)), deepConcurrency: 3, log: (m) => console.log(m) });
  console.log(`done: ${sum.screened}/${sum.total} screened, ${sum.deep} analysed in depth, ${sum.errors} errors, ${sum.seconds}s${Object.keys(sum.schemaWarnings).length ? `; schema warnings: ${JSON.stringify(sum.schemaWarnings)}` : ''}`); return 0;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().then((c) => process.exit(c), (e) => { console.error(e.message); process.exit(1); });
