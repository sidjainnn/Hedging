// Produce the timeline the static demo dashboard replays.
//
// This is NOT a mock. It drives the service's real code path —
// GamebullInventorySource → Gate → Hedger → DryRunVenue — over REAL Binance
// 1-second BTC klines. The only synthetic part is the house BOOK: no live
// exchange is reachable from a static host, so user flow is generated from a
// seeded RNG. Every delta, gate decision and hedge order below is computed by
// the same code that runs in production.
//
//   npx tsx scripts/demo-timeline.ts > site/timeline.json

import { GamebullInventorySource } from '../src/inventory/gamebull.js';
import type { RedisLike } from '../src/inventory/types.js';
import { Gate } from '../src/core/gate.js';
import { Hedger } from '../src/core/hedger.js';
import { DryRunVenue } from '../src/venue/dry-run.js';

const SYMBOL = 'BTCUSDT';
const TENOR_SEC = 300;
const ACTIVE_KEY = 'predictor_active_markets';
const K_YES = 'MMP_LMSR_QUANTITY_YES_';
const K_NO = 'MMP_LMSR_QUANTITY_NO_';
const K_META = 'MMP_MARKET_META_';

// deterministic RNG so the published timeline is reproducible
let seed = 42;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

async function klines(): Promise<{ t: number; c: number }[]> {
  const url = `https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=1s&limit=1000`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`binance ${r.status}`);
  return (await r.json() as unknown[][]).map((k) => ({ t: Number(k[0]), c: parseFloat(k[4] as string) }));
}

// in-memory Redis holding the synthetic book, same shape the real adapter reads
const store: Record<string, string> = {};
let active: string[] = [];
const redis: RedisLike = {
  get: async (k) => store[k] ?? null,
  smembers: async () => active,
};

const source = new GamebullInventorySource(redis, {
  symbol: SYMBOL, hedgeableFeedIds: [3], activeMarketsKey: ACTIVE_KEY,
  keyYes: K_YES, keyNo: K_NO, keyMeta: K_META,
  minTauSec: 60, expiryLockoutSec: 20, deltaCurve: 'empirical',
});

const gate = new Gate({
  volGate: true, volThreshold: 2e-5, volHysteresis: 0.6,
  mode: 'fixed', notionalFloor: 80, pctl: 0.6,
});

const venue = new DryRunVenue();
const hedger = new Hedger(venue, { maxNotionalUsdt: 10_000, deadbandUsdt: 75 }, true);

const bars = await klines();
const returns: number[] = [];
const out: Record<string, number | string | boolean>[] = [];

let marketId = '';
let expiryTs = 0;

for (let i = 1; i < bars.length; i++) {
  const { t, c: spot } = bars[i];
  venue.setMark(spot);

  // roll a fresh at-the-money market every TENOR_SEC
  if (!marketId || t >= expiryTs) {
    marketId = `btc5m${t}`;
    expiryTs = t + TENOR_SEC * 1000;
    active = [marketId];
    store[`${K_META}${marketId}`] = JSON.stringify({
      underlyingSymbol: SYMBOL, strike: Math.round(spot / 10) * 10, expiryTs, feedId: 3,
    });
    store[`${K_YES}${marketId}`] = '0';
    store[`${K_NO}${marketId}`] = '0';
  }

  // synthetic user flow: sporadic arrivals, momentum-leaning side choice
  if (rnd() < 0.05) {
    const drift = spot - bars[i - 1].c;
    const buyYes = rnd() < (drift >= 0 ? 0.62 : 0.38);
    const size = Math.round(1 + rnd() * 12);
    const key = buyYes ? K_YES : K_NO;
    store[`${key}${marketId}`] = String(Number(store[`${key}${marketId}`] ?? 0) + size);
  }

  // realised per-tick vol over a 60s window
  returns.push(spot / bars[i - 1].c - 1);
  if (returns.length > 60) returns.shift();
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const vol = Math.sqrt(returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length);

  // ── the real pipeline ───────────────────────────────────────────────────
  const inv = await source.poll(spot, vol, t);
  const status = gate.update(vol, inv.notionalUsdt, true);
  const target = status.armed ? inv.aggregateDelta : 0;
  await hedger.reconcile(target, spot);

  out.push({
    t, spot,
    delta: inv.aggregateDelta,
    notionalUsdt: inv.notionalUsdt,
    netContractsYes: inv.netContractsYes,
    strike: inv.markets[0]?.strike ?? 0,
    tauSec: Math.max(0, (expiryTs - t) / 1000),
    armed: status.armed,
    idleReason: status.idleReason,
    realizedVol: vol,
    position: await venue.getPositionUnits(),
    hedgePnl: hedger.hedgePnl(spot),
    fees: (hedger as unknown as { feesPaid?: number }).feesPaid ?? 0,
  });
}

process.stdout.write(JSON.stringify({
  generatedAt: new Date().toISOString(),
  note: 'Real GamebullInventorySource/Gate/Hedger/DryRunVenue over real Binance 1s klines; house book is synthetic.',
  symbol: SYMBOL,
  points: out,
}, null, 0));
