// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NullOptionsProvider, makeOptionsProvider, optionsProviderStatus } from '../providers/options.js';

test('NullOptionsProvider returns unavailable chain (never fabricates)', async () => {
  const r = await new NullOptionsProvider().getChain('AAPL');
  assert.equal(r.available, false); assert.ok(r.error);
  assert.equal(r.chain.fieldsAvailable.chain, false);
});

test('only uw is supported; any other OPTIONS_PROVIDER value is unconfigured', () => {
  const st = optionsProviderStatus({ OPTIONS_PROVIDER: 'oldvendor', UNUSUAL_WHALES_API_TOKEN: 'tok1234' });
  assert.equal(st.configured, false);
  assert.match(st.reason, /unknown OPTIONS_PROVIDER/i);
  assert.equal(optionsProviderStatus({ OPTIONS_PROVIDER: 'uw', UNUSUAL_WHALES_API_TOKEN: 'tok1234' }).configured, true);
});

test('makeOptionsProvider: env-driven selection (uw | null)', () => {
  assert.equal(makeOptionsProvider({}).name, 'null');
      assert.equal(makeOptionsProvider({ OPTIONS_PROVIDER: 'oldvendor', UNUSUAL_WHALES_API_TOKEN: 'k' }).name, 'null'); // unsupported -> null
});

test('optionsProviderStatus reflects config', () => {
  const empty = optionsProviderStatus({});
  assert.equal(empty.provider, 'null'); assert.equal(empty.configured, false); assert.equal(empty.keyMasked, null);
  assert.match(empty.reason, /OPTIONS_PROVIDER not set/i);
  const ok = optionsProviderStatus({ OPTIONS_PROVIDER: 'uw', UNUSUAL_WHALES_API_TOKEN: 'abcd1234wxyz' });
  assert.equal(ok.provider, 'uw'); assert.equal(ok.configured, true); assert.equal(ok.keyMasked, '********wxyz'); assert.equal(ok.reason, null);
});
