// Pure keyed diff between two snapshots: which rows are new / dropped / changed, and rank movement.
export function diffRows(prev, next, keyFn, fields) {
  const pm = new Map((prev || []).map((r, i) => [keyFn(r), { r, i }]));
  const nm = new Map(next.map((r, i) => [keyFn(r), { r, i }]));
  const added = [], removed = [], changed = new Map(), rankDelta = new Map();
  for (const [k, { r, i }] of nm) {
    const old = pm.get(k);
    if (!old) { if (prev && prev.length) added.push(k); continue; }
    const ch = (fields || Object.keys(r)).filter((f) => old.r[f] !== r[f]);
    if (ch.length) changed.set(k, ch);
    if (old.i !== i) rankDelta.set(k, old.i - i);          // > 0 = moved up
  }
  for (const k of pm.keys()) if (!nm.has(k)) removed.push(k);
  return { added, removed, changed, rankDelta };
}
