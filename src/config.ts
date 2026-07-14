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
  spotRedisKey: env.SPOT_REDIS_KEY ?? 'CRYPTO_SPOT_BTCUSDT',

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
  hedgeDeadbandUsdt: parseFloat(env.HEDGE_DEADBAND_USDT ?? '75'),
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
