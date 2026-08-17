import 'dotenv/config';

// Production hosts are hard-blocked so this can never touch real money.
const MAINNET_HOSTS = ['api.binance.com', 'fapi.binance.com', 'api1.binance.com', 'api2.binance.com', 'api3.binance.com'];

export function assertPaper(base: string, label: string): string {
  let host: string;
  try {
    host = new URL(base).host;
  } catch {
    throw new Error(`Invalid ${label} URL: ${base}`);
  }
  if (MAINNET_HOSTS.includes(host)) {
    throw new Error(
      `REFUSING TO START: ${label}=${base} is a PRODUCTION (real-money) host. ` +
        `This service only allows demo/testnet venues.`,
    );
  }
  return base;
}

const env = process.env;
const bool = (v: string | undefined, def: boolean) => (v === undefined ? def : v.toLowerCase() === 'true');

export const config = {
  port: parseInt(env.PORT ?? '8790', 10),
  symbol: (env.SYMBOL ?? 'BTCUSDT').toUpperCase(),
  hedgeIntervalSec: parseInt(env.HEDGE_INTERVAL_SEC ?? '10', 10),
  // Floor on the per-second vol used for the digital delta. Cold vol history
  // (few samples) gives σ≈0, which degenerates dp/dS (→0 off-strike, →∞ at-strike).
  // Live 1s BTC realized vol sits ~4e-5, so floor there. Only affects the delta
  // math, NOT the vol GATE (which still sees raw realized vol).
  minSigmaPerSec: parseFloat(env.MIN_SIGMA_PER_SEC ?? '0.00004'),
  // Ledger window (ms). Default 5min = the markets' tenor; lower it for testing.
  ledgerWindowMs: parseInt(env.LEDGER_WINDOW_MS ?? '300000', 10),

  // ── inventory source (read-only) ──────────────────────────────────────────
  inventorySource: (env.INVENTORY_SOURCE ?? 'gamebull') as 'gamebull' | 'empty',
  predictorRedisHost: env.PREDICTOR_REDIS_HOST ?? '127.0.0.1',
  predictorRedisPort: parseInt(env.PREDICTOR_REDIS_PORT ?? '6379', 10),
  hedgeableFeedIds: (env.HEDGEABLE_FEED_IDS ?? '3').split(',').map((s) => parseInt(s.trim(), 10)),
  activeMarketsKey: env.ACTIVE_MARKETS_KEY ?? 'predictor_active_markets',
  lmsrKeyYes: env.MMP_LMSR_KEY_YES ?? 'MMP_LMSR_QUANTITY_YES_',
  lmsrKeyNo: env.MMP_LMSR_KEY_NO ?? 'MMP_LMSR_QUANTITY_NO_',
  lmsrKeyMeta: env.MMP_MARKET_META_KEY ?? 'MMP_MARKET_META_',
  // Which curve sizes the hedge. 'empirical' (default) differentiates the curve
  // the exchange actually quotes on; 'bs' is the legacy Black-Scholes delta,
  // retained only as a rollback. See src/core/empirical.ts for why the default
  // changed — 'bs' over-hedged by 1.6-2.2x against observed quote moves.
  deltaCurve: (env.DELTA_CURVE ?? 'empirical') as 'empirical' | 'bs',
  // Gamma-wall guards (see GamebullSourceOpts). A 5m binary's dp/dS diverges as
  // τ→0: with ~4k contracts the book demanded 88 BTC / $5.8M of hedge at τ≈1s,
  // which the venue rejected outright. Floor τ at 60s for the delta and ignore
  // markets in their last 20s — mirroring the quoting side's expiry lockout.
  hedgeMinTauSec: parseFloat(env.HEDGE_MIN_TAU_SEC ?? '60'),
  hedgeExpiryLockoutSec: parseFloat(env.HEDGE_EXPIRY_LOCKOUT_SEC ?? '20'),
  spotRedisKey: env.SPOT_REDIS_KEY ?? 'CRYPTO_SPOT_BTCUSDT',
  // Spot feed source: 'ws' = the service's own Binance WebSocket (real-time,
  // self-sufficient — default); 'redis' = read CRYPTO_SPOT_* from Redis (fed by
  // an external oracle-feed, e.g. the local stack).
  spotSource: (env.SPOT_SOURCE ?? 'ws') as 'ws' | 'redis',
  binanceWsBase: env.BINANCE_WS_BASE ?? 'wss://stream.binance.com:9443',
  // Public futures mark-price WS host (read-only). Opt-in: set to
  // 'wss://fstream.binance.com' where Binance futures streams are reachable.
  // Empty (default) = REST mark via /fapi/v1/premiumIndex. The mark is off the
  // hot path (the loop hedges on the SPOT WS); this only affects getMarkPrice.
  futuresWsBase: env.FUTURES_WS_BASE ?? '',
  feedStaleMs: parseInt(env.FEED_STALE_MS ?? '15000', 10),

  // ── execution venue ───────────────────────────────────────────────────────
  executionVenue: (env.EXECUTION_VENUE ?? 'dry-run') as 'dry-run' | 'binance-demo',
  apiKey: env.BINANCE_API_KEY ?? '',
  apiSecret: env.BINANCE_API_SECRET ?? '',
  // assertPaper runs even in dry-run so a misconfigured prod host fails loudly.
  futuresBase: assertPaper(env.FUTURES_BASE ?? 'https://demo-fapi.binance.com', 'FUTURES_BASE'),
  leverage: parseInt(env.HEDGE_LEVERAGE ?? '1', 10),
  // Multi-Assets Mode ON so USDC + USDT together back the BTCUSDT hedge.
  multiAssets: bool(env.MULTI_ASSETS_MARGIN, true),

  // ── risk gate (mirrors amm-hedging) ───────────────────────────────────────
  hedgeEnabled: bool(env.HEDGE_ENABLED, false),
  hedgeVolGate: bool(env.HEDGE_VOL_GATE, false),
  hedgeVolWindow: parseInt(env.HEDGE_VOL_WINDOW ?? '60', 10),
  hedgeVolThreshold: parseFloat(env.HEDGE_VOL_THRESHOLD ?? '0.0002'),
  hedgeVolHysteresis: parseFloat(env.HEDGE_VOL_HYSTERESIS ?? '0.6'),
  hedgeGateMode: (env.HEDGE_GATE_MODE ?? 'adaptive') as 'adaptive' | 'fixed',
  hedgeGatePctl: parseFloat(env.HEDGE_GATE_PCTL ?? '0.6'),
  hedgeNotionalUsdt: parseFloat(env.HEDGE_NOTIONAL_USDT ?? '80'),
  maxNotionalUsdt: parseFloat(env.MAX_NOTIONAL_USDT ?? '10000'),
  // Fraction of aggregate delta actually hedged. 1.0 = full delta (current
  // behaviour, and the default so this ships inert).
  //
  // Why this lever exists: hedge FEES scale with perp notional while REVENUE
  // scales with binary notional, and the two differ by ~300x. Measured over
  // 38,875 real BTC 5-minute windows, the most a 3c spread can fund is
  // f = 0.125 on taker fees or f = 0.250 on maker — beyond that the hedge
  // costs more than the spread earns. Break-even f by spread and fee model:
  //
  //     spread   taker    maker
  //       1c     0.042    0.083
  //       3c     0.125    0.250
  //       6c     0.250    0.500
  //      10c     0.417    0.833
  //
  // Risk removed is close to LINEAR in f (26% at f=1.0, ~12% at f=0.3), so
  // there is no free "sweet spot" — this is a straight purchase of variance
  // reduction, and the table above is what the spread can afford.
  hedgeFraction: Math.max(0, Math.min(1, parseFloat(env.HEDGE_FRACTION ?? '1'))),
  // Post the hedge (maker, ~half the taker fee) before crossing. OFF by
  // default: this changes the money path. Roughly DOUBLES the hedge fraction a
  // given spread can fund — at a 3c spread, f=0.125 taker vs f=0.250 maker.
  // Unfilled remainder is completed by crossing within the same reconcile, so
  // enabling this never leaves the hedge short of target.
  preferMaker: (env.PREFER_MAKER ?? '0') === '1',
  // How long a post-only order rests before we give up and cross.
  //
  // Measured on 32,400 real 1-second BTC bars, a resting order at the touch
  // fills only ~12% of the time within 1s and ~31% within 5s — far less often
  // than the maker path's first justification assumed. Missing is also ADVERSELY
  // SELECTED: fills happen when price comes to us, misses when it runs away, so
  // a miss leaves us crossing at a worse price. Net expected value per hedge:
  //
  //     1s  fill 12.0%  net +$0.27
  //     3s  fill 23.6%  net +$0.48
  //     5s  fill 30.8%  net +$0.59
  //    30s  fill 62.2%  net +$1.00
  //
  // Positive at every horizon, but small — the honest figure is well under a
  // dollar per hedge, not the $3.00 a naive "maker saves 3bps" reading gives.
  // Longer is better on the MEAN, but the wait is time spent UNHEDGED, and that
  // variance is the thing the hedge exists to remove; do not read the 30s row
  // as a recommendation. 5s is a deliberate compromise, and it must stay
  // comfortably below HEDGE_INTERVAL_SEC or successive cycles would post
  // overlapping orders against each other (clamped below).
  makerTimeoutMs: parseInt(env.MAKER_TIMEOUT_MS ?? '5000', 10),
  // Deadband now TAPERS with time-to-expiry of the nearest active market
  // (src/core/taper.ts) instead of being one flat number for the whole
  // market life: tight (HEDGE_DEADBAND_USDT, kept as the "tight" name for
  // continuity) far from expiry, where gamma is small and a real signal is
  // cheap to react to — loosening toward HEDGE_DEADBAND_LOOSE_USDT as the
  // gamma wall approaches, where chasing small moves is mostly fee churn on
  // a position about to resolve itself. REF_SEC matches the quoting side's
  // 5-minute market tenor (gb-crypto-local drivers/lib/quoting.mjs REF_SEC).
  hedgeDeadbandUsdt: parseFloat(env.HEDGE_DEADBAND_USDT ?? '125'),
  hedgeDeadbandLooseUsdt: parseFloat(env.HEDGE_DEADBAND_LOOSE_USDT ?? '400'),
  hedgeDeadbandRefSec: parseFloat(env.HEDGE_DEADBAND_REF_SEC ?? '300'),
  // On SIGTERM/SIGINT: flatten the position (leave no unmonitored perp) or hold it
  // (keep the book hedged across a restart). Default HOLD — a brief restart
  // shouldn't churn the hedge; set true for environments where an unwatched
  // position is the bigger risk.
  flattenOnShutdown: bool(env.FLATTEN_ON_SHUTDOWN, false),

  hasKeys(): boolean {
    return this.apiKey.length > 0 && this.apiSecret.length > 0;
  },
};

export type Config = typeof config;
