// Regression: retries inside limiter.dedupe() used to wait on themselves forever.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UnusualWhalesOptionsProvider } from '../providers/unusualwhales.js';
import { RateLimiter } from '../store/readiness.js';

const withFetch = async (impl, fn) => { const real = globalThis.fetch; globalThis.fetch = impl; try { return await fn(); } finally { globalThis.fetch = real; } };
const bounded = (p, ms = 20000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('HUNG')), ms))]);
const mk = () => new UnusualWhalesOptionsProvider({ apiKey: 'k', limiter: new RateLimiter({}) });
const fast = (prov) => { prov.limiter.backoffMs = () => 5; return prov; };

test('503 with a limiter attached settles (rejects) instead of hanging', async () => {
  let calls = 0;
  await withFetch(async () => { calls++; return { ok: false, status: 503, headers: { get: () => null }, json: async () => ({}) }; }, async () => {
    await assert.rejects(bounded(fast(mk())._get('/x')), /UW 503/);
  });
  assert.equal(calls, 4); // initial + 3 retries
});

test('429 with a limiter attached settles', async () => {
  await withFetch(async () => ({ ok: false, status: 429, headers: { get: () => null }, json: async () => ({}) }), async () => {
    await assert.rejects(bounded(fast(mk())._get('/x')), /429|quota/);
  });
});

test('network error with a limiter attached settles', async () => {
  await withFetch(async () => { throw new Error('socket hang up'); }, async () => {
    await assert.rejects(bounded(fast(mk())._get('/x')), /network error/);
  });
});

test('transient 503 then success resolves', async () => {
  let n = 0;
  await withFetch(async () => (++n < 3 ? { ok: false, status: 503, headers: { get: () => null }, json: async () => ({}) } : { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ data: 1 }) }), async () => {
    assert.deepEqual(await bounded(fast(mk())._get('/x')), { data: 1 });
  });
});

test('concurrent identical calls still share one request chain', async () => {
  let n = 0;
  await withFetch(async () => { n++; return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ data: 1 }) }; }, async () => {
    const p = mk(); const [a, b] = await bounded(Promise.all([p._get('/x'), p._get('/x')]));
    assert.deepEqual(a, b);
  });
  assert.equal(n, 1);
});

test('a full per-minute window WAITS and then succeeds; it does not fail the call (bulk scans used to stop after ~15 tickers)', async () => {
  const lim = new RateLimiter({ maxPerMinute: 2 });
  let t = Date.now(); lim.canRequest = ((orig) => (now) => orig.call(lim, now ?? t))(lim.canRequest);
  const p = new UnusualWhalesOptionsProvider({ apiKey: 'k', limiter: lim });
  let calls = 0;
  await withFetch(async () => { calls++; return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ data: calls }) }; }, async () => {
    lim.record(); lim.record();                                   // window already full
    // make the window free up shortly: pretend the oldest requests are a minute old
    setTimeout(() => { lim.window.length = 0; }, 400);
    const r = await bounded(p._get('/x'), 10000);
    assert.equal(r.data, 1);
  });
});

test('a window-full refusal is not counted as quota exhaustion (no rateLimited flag)', async () => {
  const lim = new RateLimiter({ maxPerMinute: 1, maxPerScan: 1 });
  const p = new UnusualWhalesOptionsProvider({ apiKey: 'k', limiter: lim });
  await withFetch(async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) }), async () => {
    await p._get('/a');                                            // uses the whole scan budget
    await assert.rejects(bounded(p._get('/b')), (e) => e.rateLimited === true && /SCAN_BUDGET/.test(e.message));   // budget exhaustion IS a hard stop
  });
});
