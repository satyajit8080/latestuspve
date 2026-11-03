import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseEnv } from '../lib/env.js';
import { resolveSecrets, LoginThrottle } from '../lib/auth.js';

const ROOT = path.resolve(import.meta.dirname, '..');

function trackedFiles() {
  const r = spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.split('\n').filter(Boolean);
  const out = []; const walk = (d) => { for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) { if (['node_modules', '.git', 'research-data'].includes(e.name)) continue; const rel = path.join(d, e.name); e.isDirectory() ? walk(rel) : out.push(rel); } }; walk('.'); return out;
}

test('no literal default password anywhere in tracked files', () => {
  const old = 'Satyajit' + 'DD7', flag = 'ALLOW_DEFAULT' + '_PASSWORD';   // split so this file does not match itself
  const hits = [];
  for (const f of trackedFiles()) {
    if (/\.(pdf|png|jpg|ico|lock)$/i.test(f) || f.startsWith('package-lock')) continue;
    let txt; try { txt = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { continue; }
    if (txt.includes(old) || txt.includes(flag)) hits.push(f);
  }
  assert.deepEqual(hits, []);
});

test('server exits without DASHBOARD_PASSWORD', () => {
  const env = { ...process.env, NODE_ENV: 'production', PORT: '0' }; delete env.DASHBOARD_PASSWORD; delete env.SESSION_SECRET;
  const r = spawnSync(process.execPath, ['server.js'], { cwd: ROOT, env, encoding: 'utf8', timeout: 15000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /DASHBOARD_PASSWORD/);
});

test('resolveSecrets enforces length and requires SESSION_SECRET outside test', () => {
  assert.throws(() => resolveSecrets({ NODE_ENV: 'production', DASHBOARD_PASSWORD: 'short', SESSION_SECRET: 'x'.repeat(40) }), /16/);
  assert.throws(() => resolveSecrets({ NODE_ENV: 'production', DASHBOARD_PASSWORD: 'p'.repeat(16) }), /SESSION_SECRET/);
  assert.throws(() => resolveSecrets({ NODE_ENV: 'production', DASHBOARD_PASSWORD: 'p'.repeat(16), SESSION_SECRET: 'short' }), /32/);
  assert.throws(() => resolveSecrets({ NODE_ENV: 'test' }), /DASHBOARD_PASSWORD/);
  const ok = resolveSecrets({ NODE_ENV: 'production', DASHBOARD_PASSWORD: 'p'.repeat(16), SESSION_SECRET: 's'.repeat(32) });
  assert.equal(ok.password.length, 16);
});

test('login throttle: lockout after 5 failures, doubles, resets on success', () => {
  let t = 0; const th = new LoginThrottle({ now: () => t });
  for (let i = 0; i < 4; i++) { th.fail('1.1.1.1'); assert.equal(th.check('1.1.1.1').ok, true); }
  th.fail('1.1.1.1');
  const g = th.check('1.1.1.1'); assert.equal(g.ok, false); assert.equal(g.retryAfterMs, 60000);
  assert.equal(th.check('2.2.2.2').ok, true);                       // other IPs unaffected
  t += 60001; assert.equal(th.check('1.1.1.1').ok, true);
  for (let i = 0; i < 5; i++) th.fail('1.1.1.1');
  assert.equal(th.check('1.1.1.1').retryAfterMs, 120000);            // second lockout doubles
  t += 120001; th.success('1.1.1.1'); assert.equal(th.byIp.has('1.1.1.1'), false);
});

test('.env parser strips inline comments, honours quotes', () => {
  const e = parseEnv('OPENROUTER_API_KEY= # sk-or-fake\nOPENROUTER_MODEL=openai/gpt-4o-mini # cheap\nQ="a # b"\nS=\'x\'\nEMPTY=\nexport K=v\n# comment\n');
  assert.equal(e.OPENROUTER_API_KEY, '');
  assert.equal(e.OPENROUTER_MODEL, 'openai/gpt-4o-mini');
  assert.equal(e.Q, 'a # b'); assert.equal(e.S, 'x'); assert.equal(e.EMPTY, ''); assert.equal(e.K, 'v');
});

test('.env.example: unique keys, no inline comments, no legacy vendors', () => {
  const lines = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8').split('\n');
  const keys = [];
  for (const l of lines) { if (!l.trim() || l.trim().startsWith('#')) continue; const m = l.match(/^([A-Z0-9_]+)=(.*)$/); assert.ok(m, 'bad line: ' + l); keys.push(m[1]); assert.ok(!/\s#/.test(m[2]), 'inline comment: ' + l); }
  assert.equal(new Set(keys).size, keys.length, 'duplicate keys');
  for (const k of ['OPTIONS_PROVIDER', 'UNUSUAL_WHALES_API_TOKEN', 'DASHBOARD_PASSWORD', 'SESSION_SECRET', 'UW_MAX_PER_MINUTE', 'UW_MAX_PER_SCAN', 'SCAN_LIMIT', 'SCAN_GAP_MS', 'SIGNAL_LOG_DIR', 'BASELINE_DIR', 'SCAN_DIR', 'AI_ENABLED']) assert.ok(keys.includes(k), k);
  assert.equal(lines.find((l) => l.startsWith('AI_ENABLED=')), 'AI_ENABLED=false');
  assert.equal(lines.find((l) => l.startsWith('UNUSUAL_WHALES_API_TOKEN=')), 'UNUSUAL_WHALES_API_TOKEN=');
  assert.ok(!/pve_live|polygon|OPTIONS_API_KEY/i.test(lines.join('\n')));
});
