// Bootstrap: config → wire deps → start loop + control plane.
import { config } from './config.js';
import { GamebullInventorySource, EmptyInventorySource, connectPredictorRedis } from './inventory/gamebull.js';
import type { InventorySource } from './inventory/types.js';
import { DryRunVenue } from './venue/dry-run.js';
import { BinanceDemoVenue } from './venue/binance-demo.js';
import type { ExecutionVenue } from './venue/types.js';
import { Gate } from './core/gate.js';
import { Hedger } from './core/hedger.js';
import { Loop } from './loop.js';
import { ServiceLedger } from './core/ledger.js';
import { ExposureRecorder } from './core/exposure-recorder.js';
import { BinanceWsSpotFeed } from './feed/binance-ws.js';
import { buildServer } from './http/server.js';

async function main() {
  console.log(`[hedging] starting · symbol=${config.symbol} venue=${config.executionVenue} inventory=${config.inventorySource} interval=${config.hedgeIntervalSec}s`);

  // ── inventory source ──────────────────────────────────────────────────────
  let inventory: InventorySource;
  let redis: Awaited<ReturnType<typeof connectPredictorRedis>> | null = null;
  if (config.inventorySource === 'gamebull') {
    try {
      redis = await connectPredictorRedis(config.predictorRedisHost, config.predictorRedisPort);
      console.log(`[hedging] predictor Redis connected ${config.predictorRedisHost}:${config.predictorRedisPort}`);
    } catch (e) {
      console.error(`[hedging] Redis connect failed (${String(e).slice(0, 60)}) — running with EMPTY inventory`);
    }
    inventory = redis
      ? new GamebullInventorySource(redis, {
          symbol: config.symbol, hedgeableFeedIds: config.hedgeableFeedIds, activeMarketsKey: config.activeMarketsKey,
          keyYes: config.lmsrKeyYes, keyNo: config.lmsrKeyNo, keyMeta: config.lmsrKeyMeta,
          minTauSec: config.hedgeMinTauSec, expiryLockoutSec: config.hedgeExpiryLockoutSec,
          deltaCurve: config.deltaCurve,
        })
      : new EmptyInventorySource();
  } else {
    inventory = new EmptyInventorySource();
  }

  // ── spot feed (independent of inventory) ──────────────────────────────────
  let feed: BinanceWsSpotFeed | null = null;
  let getSpot: () => Promise<number | null>;
  if (config.spotSource === 'ws') {
    feed = new BinanceWsSpotFeed(config.symbol, config.binanceWsBase, config.feedStaleMs);
    feed.start();
    console.log(`[hedging] spot feed: Binance WebSocket (${config.symbol})`);
    getSpot = async () => feed!.latest();
  } else if (redis) {
    const r = redis;
    console.log(`[hedging] spot feed: Redis ${config.spotRedisKey}`);
    getSpot = async () => {
      try {
        const raw = await r.getRaw(config.spotRedisKey);
        if (!raw) return null;
        const v = JSON.parse(raw);
        return typeof v?.price === 'number' ? v.price : (typeof v === 'number' ? v : null);
      } catch { return null; }
    };
  } else {
    getSpot = async () => null;
  }

  // ── execution venue ───────────────────────────────────────────────────────
  let venue: ExecutionVenue;
  if (config.executionVenue === 'binance-demo') {
    const bv = new BinanceDemoVenue({ apiKey: config.apiKey, apiSecret: config.apiSecret, futuresBase: config.futuresBase, symbol: config.symbol, markWsBase: config.futuresWsBase || undefined });
    if (!bv.hasKeys()) console.warn('[hedging] binance-demo has NO keys — observe-only (no orders will place)');
    await bv.prepare(config.leverage, config.multiAssets); // leverage + multi-assets margin
    // flatten any orphan position from a prior run before trading
    const orphan = bv.hasKeys() ? await bv.getPositionUnits().catch(() => 0) : 0;
    if (Math.abs(orphan) > 0) {
      console.log(`[hedging] flattening orphan position ${orphan} BTC on startup`);
      await bv.marketOrder(orphan > 0 ? 'SELL' : 'BUY', Math.abs(orphan), true).catch((e) => console.error('[hedging] orphan flatten failed:', String(e).slice(0, 80)));
    }
    venue = bv;
  } else {
    venue = new DryRunVenue();
    if (venue.setLeverage) await venue.setLeverage(config.leverage).catch(() => {});
  }

  // ── gate + hedger + loop ──────────────────────────────────────────────────
  const gate = new Gate({
    volGate: config.hedgeVolGate, volThreshold: config.hedgeVolThreshold, volHysteresis: config.hedgeVolHysteresis,
    mode: config.hedgeGateMode, notionalFloor: config.hedgeNotionalUsdt, pctl: config.hedgeGatePctl,
  });
  const hedger = new Hedger(venue, { maxNotionalUsdt: config.maxNotionalUsdt, deadbandUsdt: config.hedgeDeadbandUsdt, preferMaker: config.preferMaker,
    // Hard cap at half the hedge loop interval: a timeout longer than the
    // loop would leave one cycle's resting order still live when the next
    // cycle posts, so the two would compete on the same book.
    makerTimeoutMs: Math.min(config.makerTimeoutMs, config.hedgeIntervalSec * 500) }, config.hedgeEnabled);

  const ledger = new ServiceLedger(config.ledgerWindowMs);
  // Phase 0 feasibility instrumentation only (cross-market-hedging-research-plan.md) —
  // off unless explicitly requested, no effect on gate/hedger/quoting behavior either way.
  const exposureRecorder = process.env.RECORD_EXPOSURE === 'true' ? new ExposureRecorder() : undefined;
  if (exposureRecorder) console.log('[hedging] RECORD_EXPOSURE=true — writing per-market exposure/gamma series to data/exposure.csv');
  const loop = new Loop({
    inventory, venue, gate, hedger, getSpot, exposureRecorder,
    intervalSec: config.hedgeIntervalSec, volWindow: config.hedgeVolWindow,
    minSigmaPerSec: config.minSigmaPerSec, ledger,
    deadbandTightUsdt: config.hedgeDeadbandUsdt, deadbandLooseUsdt: config.hedgeDeadbandLooseUsdt,
    hedgeFraction: config.hedgeFraction,
    deadbandRefSec: config.hedgeDeadbandRefSec,
  });
  loop.start();

  const app = buildServer({ loop, gate, hedger, venue, ledger });
  await app.listen({ port: config.port, host: '0.0.0.0' });
  console.log(`[hedging] control plane on :${config.port} — GET /health /state`);

  const shutdown = async () => {
    console.log('[hedging] shutting down…');
    loop.stop();
    feed?.stop();
    if (config.flattenOnShutdown) {
      const mark = loop.state.spot ?? (await venue.getMarkPrice().catch(() => 0));
      if (mark > 0) {
        console.log('[hedging] FLATTEN_ON_SHUTDOWN — closing position');
        await hedger.flatten(mark).catch((e) => console.error('[hedging] shutdown flatten failed:', String(e).slice(0, 80)));
      }
    } else if (Math.abs(hedger.livePosition) > 0) {
      console.log(`[hedging] holding position ${hedger.livePosition} BTC across shutdown (FLATTEN_ON_SHUTDOWN=false)`);
    }
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('[hedging] fatal:', e);
  process.exit(1);
});
