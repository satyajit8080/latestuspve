#!/usr/bin/env node
// scripts/intel-probe.mjs — RUN ON THE SERVER. Checks every Options Intelligence endpoint against the live API and saves
// research-data/intel/endpoint-probe.json (shown on the Options Intelligence status panel). The token is never printed.
//   node scripts/intel-probe.mjs [TICKER]
import fs from 'node:fs';
import path from 'node:path';
import { loadEnvFile } from '../lib/env.js';
import { makeOptionsProvider } from '../providers/options.js';
import { createIntelAdapter } from '../providers/uw-intel.js';
import { probeEndpoints } from '../engine/intel/probe.js';
import { intelDir } from '../store/intel-store.js';
loadEnvFile(path.join(process.cwd(), '.env'), process.env, fs);
const provider = makeOptionsProvider(process.env); if (provider.name === 'null') { console.error(provider.reason); process.exit(1); }
const t = (process.argv[2] || 'AAPL').toUpperCase(); const out = await probeEndpoints(createIntelAdapter(provider), t);
for (const [k, r] of Object.entries(out.results)) console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${k.padEnd(13)} ${r.verified ? 'verified   ' : 'EXPERIMENTAL'} rows=${String(r.rows).padEnd(4)} ${r.missing.length ? `missing: ${r.missing.join(',')}` : ''}${r.error ? ` ${r.error}` : ''}`);
const dir = intelDir(process.env); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'endpoint-probe.json'), JSON.stringify(out, null, 1)); console.log(`\nsaved ${path.join(dir, 'endpoint-probe.json')}`);
