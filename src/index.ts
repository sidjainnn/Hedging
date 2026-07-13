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
import { buildServer } from './http/server.js';

async function main() {
  console.log(`[hedging] starting · symbol=${config.symbol} venue=${config.executionVenue} inventory=${config.inventorySource} interval=${config.hedgeIntervalSec}s`);

  // ── inventory source + spot feed ──────────────────────────────────────────
  let inventory: InventorySource;
  let getSpot: () => Promise<number | null>;

  if (config.inventorySource === 'gamebull') {
    let redis: Awaited<ReturnType<typeof connectPredictorRedis>> | null = null;
    try {
      redis = await connectPredictorRedis(config.predictorRedisHost, config.predictorRedisPort);
      console.log(`[hedging] predictor Redis connected ${config.predictorRedisHost}:${config.predictorRedisPort}`);
    } catch (e) {
      console.error(`[hedging] Redis connect failed (${String(e).slice(0, 60)}) — running with EMPTY inventory`);
    }
    if (redis) {
      inventory = new GamebullInventorySource(redis, {
        symbol: config.symbol, hedgeableFeedIds: config.hedgeableFeedIds,
        keyYes: config.lmsrKeyYes, keyNo: config.lmsrKeyNo, keyMeta: config.lmsrKeyMeta,
      });
      const r = redis;
      getSpot = async () => {
        try {
          const raw = await r.getRaw(config.spotRedisKey);
          if (!raw) return null;
          const v = JSON.parse(raw);
          return typeof v?.price === 'number' ? v.price : (typeof v === 'number' ? v : null);
        } catch {
          return null;
        }
      };
    } else {
      inventory = new EmptyInventorySource();
      getSpot = async () => null;
    }
  } else {
    inventory = new EmptyInventorySource();
    getSpot = async () => null;
  }

  // ── execution venue ───────────────────────────────────────────────────────
  let venue: ExecutionVenue;
  if (config.executionVenue === 'binance-demo') {
    const bv = new BinanceDemoVenue({ apiKey: config.apiKey, apiSecret: config.apiSecret, futuresBase: config.futuresBase, symbol: config.symbol });
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
  const hedger = new Hedger(venue, { maxNotionalUsdt: config.maxNotionalUsdt, deadbandUsdt: config.hedgeDeadbandUsdt }, config.hedgeEnabled);

  const loop = new Loop({
    inventory, venue, gate, hedger, getSpot,
    intervalSec: config.hedgeIntervalSec, volWindow: config.hedgeVolWindow,
    minSigmaPerSec: config.minSigmaPerSec,
  });
  loop.start();

  const app = buildServer({ loop, gate, hedger, venue });
  await app.listen({ port: config.port, host: '0.0.0.0' });
  console.log(`[hedging] control plane on :${config.port} — GET /health /state`);

  const shutdown = async () => {
    console.log('[hedging] shutting down…');
    loop.stop();
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
