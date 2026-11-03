// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const importsOf = (src) => [...src.matchAll(/import\s+[^'"]*from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);

test('J: production files do NOT import from research/ (offline ML/validation stays offline)', () => {
  for (const f of ['server.js', 'validated/promotion.js', 'store/signal-log.js', 'store/journal.js', 'store/journal-store.js', 'engine/pipeline.js', 'engine/options-engine.js', 'providers/unusualwhales.js', 'providers/options.js', 'ai/agents.js', 'ticker.js']) {
    const imps = importsOf(read(f));
    for (const i of imps) assert.ok(!/(^|\/)research\//.test(i) && !i.includes('/research/'), `${f} must not import research code (found ${i})`);
  }
});

test('J: promotion switch imports only node:fs (pure, dependency-free)', () => {
  const imps = importsOf(read('validated/promotion.js'));
  assert.deepEqual(imps, ['node:fs']);
});

test('J: server transitively reaches only production modules (no research/* in its import graph)', () => {
  // BFS over local relative imports starting at server.js
  const seen = new Set(); const stack = ['server.js'];
  while (stack.length) {
    const f = stack.pop(); if (seen.has(f)) continue; seen.add(f);
    let src; try { src = read(f); } catch { continue; }
    for (const i of importsOf(src)) {
      if (!i.startsWith('.')) continue;                       // skip node/npm builtins
      let resolved = path.normalize(path.join(path.dirname(f), i));
      if (!resolved.endsWith('.js')) resolved += '.js';
      assert.ok(!resolved.includes('research/'), `server import graph reached research code via ${f} → ${i}`);
      stack.push(resolved);
    }
  }
  assert.ok(seen.has('server.js'));
});
