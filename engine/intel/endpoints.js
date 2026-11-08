// engine/intel/endpoints.js — the ONLY place Options Intelligence names Unusual Whales paths.
// `verified: true` means the path AND the listed keys were observed in a live response from this account (probe screenshots,
// 2026-11-05). `verified: false` paths come from documentation links we could not open from the build environment; they are
// fetched only on demand, shown as experimental, and never feed a score. scripts/intel-probe.mjs re-checks all of them live.
const enc = encodeURIComponent;
export const INTEL_ENDPOINTS = {
  flow: { verified: true, path: (t) => `/api/stock/${enc(t)}/flow-alerts?limit=200`, expect: ['created_at', 'type', 'strike', 'expiry', 'total_premium', 'total_ask_side_prem', 'total_bid_side_prem', 'has_multileg', 'has_sweep', 'all_opening_trades', 'volume', 'open_interest', 'underlying_price'] },
  tape: { verified: true, path: (t) => `/api/stock/${enc(t)}/net-prem-ticks`, expect: ['net_call_premium', 'net_put_premium', 'net_delta'] },
  oi: { verified: true, path: (t) => `/api/stock/${enc(t)}/oi-change?limit=500`, expect: ['option_symbol', 'oi_diff_plain', 'curr_oi', 'volume'] },
  gexLevels: { verified: true, path: (t, date) => `/api/stock/${enc(t)}/gex-levels?source=oi${date ? `&date=${date}` : ''}`, expect: ['call_wall', 'put_wall', 'gamma_flip', 'gamma_magnet'] },
  greek: { verified: true, path: (t) => `/api/stock/${enc(t)}/greek-exposure`, expect: ['date', 'call_gamma', 'put_gamma', 'call_delta', 'put_delta'] },
  strikeGex: { verified: false, path: (t) => `/api/stock/${enc(t)}/greek-exposure/strike`, expect: [] },
  ivRank: { verified: true, path: (t) => `/api/stock/${enc(t)}/iv-rank`, expect: ['date', 'volatility', 'iv_rank_1y'] },
  term: { verified: true, path: (t) => `/api/stock/${enc(t)}/volatility/term-structure`, expect: ['date', 'volatility', 'expiry', 'dte', 'implied_move', 'implied_move_perc'] },
  skew: { verified: true, path: (t) => `/api/stock/${enc(t)}/historical-risk-reversal-skew`, expect: ['date', 'delta', 'risk_reversal'] },
  bars1d: { verified: true, path: (t) => `/api/stock/${enc(t)}/ohlc/1d?limit=80`, expect: ['date', 'open', 'high', 'low', 'close', 'volume'] },
  bars5m: { verified: true, path: (t) => `/api/stock/${enc(t)}/ohlc/5m?limit=200`, expect: ['start_time', 'open', 'high', 'low', 'close', 'volume'] },
  contracts: { verified: true, path: (t) => `/api/stock/${enc(t)}/option-contracts`, expect: ['option_symbol', 'delta', 'gamma', 'implied_volatility', 'volume', 'open_interest', 'nbbo_bid', 'nbbo_ask'] },
  info: { verified: true, path: (t) => `/api/stock/${enc(t)}/info`, expect: [] },
  screener: { verified: true, path: () => '/api/screener/stocks?limit=500', expect: ['ticker'] },
  marketTide: { verified: true, path: () => '/api/market/market-tide', expect: ['timestamp', 'net_call_premium', 'net_put_premium', 'net_volume'] },
  multiLeg: { verified: false, path: (t) => `/api/option-trades/multi-leg?ticker_symbol=${enc(t)}&limit=50`, expect: [] },
  optionStance: { verified: false, path: (t) => `/api/stock/${enc(t)}/option-stance`, expect: [] },
};
export const VERIFIED = Object.entries(INTEL_ENDPOINTS).filter(([, e]) => e.verified).map(([k]) => k);
export const EXPERIMENTAL = Object.entries(INTEL_ENDPOINTS).filter(([, e]) => !e.verified).map(([k]) => k);
export const ENGINE_VERSION = 'intel-0.1.0';
