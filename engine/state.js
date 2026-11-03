// Anti-flicker state machine for the v2 shadow signal.
// A ticker moves through confirmation STATES; it never flips bull<->bear on one noisy poll.
//
// Design (fixes for: a deadband that blocked moves within a side; direct-flip-only cooldown; manual polling gaps):
//  - the score is smoothed as a SIGNED value (+bull / -bear) so a direction change passes through zero;
//  - bands use threshold HYSTERESIS: enter a band at its threshold, leave only below (threshold - deadband),
//    so a slow climb promotes BULL -> STRONG_BULL while small wiggles do not flap;
//  - BULL -> NEUTRAL -> BEAR obeys the same cooldown and flip margin as a direct BULL -> BEAR flip
//    (leaving a side starts the cooldown, and entering the opposite side from NEUTRAL counts as a flip);
//  - polling is MANUAL, so "3 polls" can mean 3 days: a gap longer than maxGapMs resets the state.

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

export const STATES = ['STRONG_BEAR', 'BEAR', 'WATCH_BEAR', 'NEUTRAL', 'WATCH_BULL', 'BULL', 'STRONG_BULL'];

export const DEFAULT_CONFIG = {
  confirmPolls: 3,        // consecutive polls required before a state change
  flipMargin: 10,         // |score| must reach signalThreshold + flipMargin to enter the opposite side
  cooldownPolls: 3,       // polls after leaving a side before the opposite side may be entered
  deadband: 5,            // hysteresis width: leave a band only below (threshold - deadband)
  ewmaAlpha: 0.3,
  watchThreshold: 55,
  signalThreshold: 65,
  strongThreshold: 80,
  maxGapMs: 90 * 60000,   // a longer gap between polls resets the machine (manual polling)
};

export const sideOf = (state) => (state.includes('BULL') ? 'bull' : state.includes('BEAR') ? 'bear' : 'neutral');
const bandOf = (state) => (state.startsWith('STRONG_') ? 3 : state === 'BULL' || state === 'BEAR' ? 2 : state.startsWith('WATCH_') ? 1 : 0);
const stateFor = (side, band) => (band === 0 || side === 'neutral' ? 'NEUTRAL' : band === 1 ? `WATCH_${side === 'bull' ? 'BULL' : 'BEAR'}` : band === 2 ? (side === 'bull' ? 'BULL' : 'BEAR') : `STRONG_${side === 'bull' ? 'BULL' : 'BEAR'}`);

// Entry-threshold mapping (no hysteresis). Kept for display and tests.
export function targetState(score, dir, cfg = DEFAULT_CONFIG) {
  if (!isNum(score) || dir == null || dir === 'neutral') return 'NEUTRAL';
  const band = score >= cfg.strongThreshold ? 3 : score >= cfg.signalThreshold ? 2 : score >= cfg.watchThreshold ? 1 : 0;
  return stateFor(dir, band);
}

// Band with hysteresis: bands up to prevBand are held until the score falls below (threshold - deadband).
export function bandWithHysteresis(abs, prevBand, cfg = DEFAULT_CONFIG) {
  const thr = [0, cfg.watchThreshold, cfg.signalThreshold, cfg.strongThreshold];
  let b = 0;
  for (let k = 1; k <= 3; k++) { const t = k <= prevBand ? thr[k] - cfg.deadband : thr[k]; if (abs >= t) b = k; }
  return b;
}

const FRESH = { state: 'NEUTRAL', smoothedSigned: null, smoothedScore: null, pendingState: null, pendingCount: 0, cooldown: 0, polls: 0, lastSide: null, lastFlipAt: null, history: [] };

// Advance the state machine by one poll. `prev` is the stored state (or null on first sight).
export function step(prev, { score, dir, at = new Date().toISOString(), cfg = DEFAULT_CONFIG } = {}) {
  const c = { ...DEFAULT_CONFIG, ...cfg };
  let p = prev || FRESH, reset = null;
  // manual polling: a stale previous poll means "N consecutive polls" no longer holds
  if (prev && prev.at && Number.isFinite(Date.parse(prev.at)) && Number.isFinite(Date.parse(at)) && Date.parse(at) - Date.parse(prev.at) > c.maxGapMs) {
    p = FRESH; reset = 'stale_gap';
  }

  // EWMA over the SIGNED score so a bull->bear change goes through zero
  const signedRaw = isNum(score) ? (dir === 'bull' ? score : dir === 'bear' ? -score : 0) : null;
  const sm = signedRaw == null ? p.smoothedSigned : (isNum(p.smoothedSigned) ? c.ewmaAlpha * signedRaw + (1 - c.ewmaAlpha) * p.smoothedSigned : signedRaw);
  const smoothedSigned = isNum(sm) ? Math.round(sm * 100) / 100 : null;
  const abs = isNum(smoothedSigned) ? Math.abs(smoothedSigned) : null;
  const side = !isNum(smoothedSigned) || smoothedSigned === 0 ? 'neutral' : smoothedSigned > 0 ? 'bull' : 'bear';

  const prevSide = sideOf(p.state), prevBand = bandOf(p.state);
  const band = isNum(abs) ? bandWithHysteresis(abs, side === prevSide ? prevBand : 0, c) : 0;
  const want = stateFor(side, band), wantSide = sideOf(want);
  const cooldown = Math.max(0, (p.cooldown || 0) - 1);
  const out = { ...p, at, polls: (p.polls || 0) + 1, smoothedSigned, smoothedScore: abs, rawScore: isNum(score) ? score : null, cooldown, changed: false, reason: reset ? reset : null, reset: !!reset, resetReason: reset };

  if (want === p.state) { out.pendingState = null; out.pendingCount = 0; out.reason = reset || 'stable'; return out; }

  // A flip = entering the opposite side of the one we are in, OR of the one we last left (BULL -> NEUTRAL -> BEAR).
  const refSide = prevSide !== 'neutral' ? prevSide : (p.lastSide || null);
  const isFlip = wantSide !== 'neutral' && refSide && refSide !== 'neutral' && wantSide !== refSide;
  if (isFlip) {
    if (cooldown > 0) { out.pendingState = null; out.pendingCount = 0; out.reason = 'cooldown'; return out; }
    if (!isNum(abs) || abs < c.signalThreshold + c.flipMargin) { out.pendingState = null; out.pendingCount = 0; out.reason = 'flip_margin_not_met'; return out; }
  }

  // require N consecutive polls agreeing on the same target before committing
  const pendingCount = p.pendingState === want ? (p.pendingCount || 0) + 1 : 1;
  out.pendingState = want; out.pendingCount = pendingCount;
  if (pendingCount < c.confirmPolls) { out.reason = `confirming ${pendingCount}/${c.confirmPolls}`; return out; }

  out.state = want; out.pendingState = null; out.pendingCount = 0; out.changed = true; out.reason = 'confirmed';
  out.persistencePolls = c.confirmPolls;
  // leaving a side (to NEUTRAL or the other side) starts the cooldown that guards the opposite side
  if (prevSide !== 'neutral' && wantSide !== prevSide) { out.lastSide = prevSide; out.cooldown = c.cooldownPolls; if (wantSide !== 'neutral') out.lastFlipAt = at; }
  if (wantSide !== 'neutral') out.lastSide = wantSide;
  out.history = [...(p.history || []).slice(-19), { state: want, at, score: abs }];
  return out;
}

// Is this state actionable (i.e. a real call, not a watch)?
export const isActionable = (state) => ['BULL', 'STRONG_BULL', 'BEAR', 'STRONG_BEAR'].includes(state);
