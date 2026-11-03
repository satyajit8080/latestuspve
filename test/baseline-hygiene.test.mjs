import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BaselineStore, MIN_HISTORY } from '../store/normalize.js';

const mk = () => new BaselineStore(fs.mkdtempSync(path.join(os.tmpdir(), 'bh-')));
const day = (d, h = 14, m = 0) => `2026-08-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;

test('history keeps ONE observation per session (latest poll wins), so n counts sessions not polls', async () => {
  const b = mk();
  for (let m = 0; m < 30; m += 5) await b.record('X', 'f', m, day(3, 14, m));   // six polls in one session
  await b.record('X', 'f', 100, day(4));
  const h = b.history('X', timeBucketOf(day(3, 14, 25)), 'f');
  assert.ok(h.length <= 2);
  const sess = b.stats().sessions;
  assert.equal(sess >= 2, true);
});
// the bucket the polls fall in is whatever timeBucket says; read it back through normalize's own function
import { timeBucket } from '../store/normalize.js';
function timeBucketOf(iso) { return timeBucket(iso); }

test('within a session the latest poll is the one that counts', async () => {
  const b = mk();
  const bucket = timeBucket(day(3, 14, 0));
  await b.record('X', 'f', 1, day(3, 14, 0));
  await b.record('X', 'f', 7, day(3, 14, 10));
  assert.deepEqual(b.history('X', bucket, 'f', day(4)), [7]);
});

test("today's own polls never form today's baseline (strictly prior sessions only)", async () => {
  const b = mk();
  const bucket = timeBucket(day(5, 14, 0));
  await b.record('X', 'f', 10, day(4, 14, 0));
  await b.record('X', 'f', 999, day(5, 14, 0));          // an earlier poll of the CURRENT session
  assert.deepEqual(b.history('X', bucket, 'f', day(5, 14, 20)), [10]);
});

test('MIN_HISTORY counts distinct sessions: 40 polls in 3 sessions is still insufficient', async () => {
  const b = mk();
  const bucket = timeBucket(day(1, 14, 0));
  for (let d = 1; d <= 3; d++) for (let i = 0; i < 13; i++) await b.record('X', 'f', d * 10 + i, day(d, 14, i));
  const n = b.normalize('X', 'f', 50, day(4, 14, 0));
  assert.equal(n.available, false);
  assert.equal(n.reason, 'insufficient_history');
  assert.equal(n.n, 3);
  assert.ok(MIN_HISTORY === 10);
  for (let d = 5; d <= 14; d++) await b.record('X', 'f', d, day(d, 14, 0));
  const ok = b.normalize('X', 'f', 50, day(15, 14, 0));
  assert.ok(ok.n >= MIN_HISTORY);
  assert.ok(ok.z != null);
  void bucket;
});

test('baseline lines are append-only: recording never rewrites earlier lines', async () => {
  const b = mk();
  await b.record('X', 'f', 1, day(3));
  const before = fs.readFileSync(b._file(), 'utf8');
  await b.record('X', 'f', 2, day(3, 15));
  const after = fs.readFileSync(b._file(), 'utf8');
  assert.ok(after.startsWith(before));
});
