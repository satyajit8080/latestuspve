// Stand-in for research/lab-worker.js used by the client and HTTP tests.
process.on('message', async (m) => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  if (m.type === 'status') return process.send({ id: m.id, ok: true, data: { dataBuilt: true, keyConfigured: true, trials: 0, ideas: [] } });
  if (m.type === 'ask') { await wait(Number(process.env.FAKE_LAB_DELAY || 0)); if (/crash/.test(m.payload.prompt)) process.exit(1); if (/boom/.test(m.payload.prompt)) return process.send({ id: m.id, ok: false, error: 'OpenRouter request failed (HTTP 401)', code: 'LLM' });
    return process.send({ id: m.id, ok: true, data: { note: null, trials: 1, bonferroniT: 1.96, results: [{ id: 'abc', name: 'fake idea', hypothesis: 'h', horizon: 1, expr: 'alertSingle', filter: null, result: { meanIC: 0.01, t: 1 }, verdict: { level: 'noise', text: 't' }, repeated: false }] } }); }
  if (m.type === 'validate') return process.send({ id: m.id, ok: true, data: { results: [] } });
  if (m.type === 'vault') return process.send({ id: m.id, ok: true, data: { results: [] } });
});
