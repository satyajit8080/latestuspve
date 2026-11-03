// Run: node --test — consolidated production-boundary proofs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildOptionsSignal, aggregateChain } from '../engine/options-engine.js';
import { NullOptionsProvider } from '../providers/options.js';

// ---- 3. No fabricated options data ----
test('BOUNDARY: NullOptionsProvider → insufficient, never fabricates', async () => {
  const { chain } = await new NullOptionsProvider().getChain('AAPL');
  const sig = buildOptionsSignal(chain);
  assert.equal(sig.insufficient, true);
  assert.equal(sig.dataQualityStatus, 'UNAVAILABLE');
});
test('BOUNDARY: missing greeks/iv/quotes → unavailable (GEX/IV/spread null, not invented)', () => {
  const bare = { ticker: 'X', underlying: { price: 100, available: true }, contracts: [{ type: 'call', strike: 100, expiration: '2026-09-18', volume: 10, openInterest: 50 }], fieldsAvailable: { chain: true, oi: true, underlying: true, greeks: false, iv: false, quotes: false } };
  const a = aggregateChain(bare);
  assert.equal(a.gex, null); assert.equal(a.atmIV, null); assert.equal(a.avgSpread, null);
  const sig = buildOptionsSignal(bare);
  assert.equal(sig.dataAvailability.greeks, false);
  assert.equal(sig.dataAvailability.sweeps, undefined === sig.dataAvailability.sweeps ? sig.dataAvailability.sweeps : false); // never true
});

// ---- 5. PVE_AGENT_KEY / secrets never in browser code ----
test('BOUNDARY: browser assets never reference the agent key/header or process.env', () => {
  const pub = path.join(import.meta.dirname, '..', 'public');
  for (const f of ['app.js', 'index.html']) {
    const src = fs.readFileSync(path.join(pub, f), 'utf8');
    assert.equal(/X-Agent-Key/i.test(src), false, `${f} must not use X-Agent-Key`);
    assert.equal(/process\.env/.test(src), false, `${f} must not read process.env`);
    assert.equal(/ghp_[A-Za-z0-9]{20}/.test(src), false, `${f} must not contain a token`);
    assert.equal(src.includes('Satyajit' + 'DD7'), false, `${f} must not contain the password`);
  }
});
