// engine/intel/explain.js — deterministic, template-based explanation (no AI): why selected, what could be wrong, what the data is missing.
const pct = (x, d = 0) => (typeof x === 'number' ? `${(x * 100).toFixed(d)}%` : 'n/a');
const k = (x) => (typeof x === 'number' ? `$${Math.round(x / 1000).toLocaleString('en-US')}k` : 'n/a');
export function explain(f, ev, levels) {
  const dir = ev.direction; const side = dir ? ev[dir] : (ev.bull.score >= ev.bear.score ? ev.bull : ev.bear);
  const why = []; const caveats = []; const missing = [];
  if (ev.state === 'NO_TRADE') why.push(`NO TRADE: ${ev.reasons.join('; ')}.`);
  else why.push(`${ev.state === 'BULL' ? 'Bullish' : 'Bearish'} evidence scores ${side.score}/100 (the other side ${(dir === 'bull' ? ev.bear : ev.bull).score}).`);
  for (const c of [...side.components].filter((x) => x.available).sort((a, b) => b.contribution - a.contribution).slice(0, 3)) why.push(`${c.label}: ${c.contribution >= 0 ? '+' : ''}${c.contribution.toFixed(1)} points. ${c.note}.`);
  const F = f.flow; if (F) { why.push(`Flow: calls bought ${k(F.callAsk)}, puts bought ${k(F.putAsk)}, calls sold ${k(F.callBid)}, puts sold ${k(F.putBid)} (single-leg alerts).`); if (F.multiLegShare > 0.4) caveats.push(`${pct(F.multiLegShare)} of premium is multi-leg: spreads and hedges can look directional.`); if (F.openingShare != null && F.openingShare < 0.3) caveats.push('Little of the flow is flagged as opening: it may be closing or hedging.'); }
  if (f.gex && f.gex.approaching && f.gex.approaching.length) caveats.push(`Price is within 1.5% of: ${f.gex.approaching.join(', ')}.`);
  if (f.vol && f.vol.ivRank > 80) caveats.push(`IV rank ${Math.round(f.vol.ivRank)}: options are expensive and a volatility drop can erase a correct direction.`);
  if (f.price && f.price.chgPct != null && f.price.atrPct && Math.abs(f.price.chgPct) > 2.5 * f.price.atrPct) caveats.push('The stock has already moved more than 2.5 ATR; in our own 2-year test a large one-day move tended to reverse the next day.');
  if (levels && levels.riskReward != null && levels.riskReward < 1.5) caveats.push(`Risk/reward to the first reference level is ${levels.riskReward}.`);
  caveats.push('A large print is evidence of activity, not proof of intent or future direction.');
  for (const [key, label] of [['flow', 'options flow'], ['tape', 'one-minute tape'], ['oi', 'open-interest change'], ['gex', 'GEX / gamma levels'], ['vol', 'volatility'], ['price', 'price bars'], ['liquidity', 'option liquidity']]) if (!f[key]) missing.push(label);
  return { why, caveats, missing };
}
