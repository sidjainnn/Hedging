// GameBull inventory source — reads the house LMSR inventory the MMP publishes to
// predictor Redis and turns it into an aggregate settlement-value delta the hedger
// can neutralize. Read-only; never writes their Redis.
//
// See docs/inventory-contract.md for the exact keys/shapes.

import { digitalProb } from '../core/digital.js';
import type { AggregateInventory, HedgeableMarket, InventorySource, MarketMeta, RedisLike } from './types.js';

export interface GamebullSourceOpts {
  symbol: string; // hedge symbol, e.g. 'BTCUSDT' — only markets on this underlying
  hedgeableFeedIds: number[]; // e.g. [3] (non-sports)
  keyYes: string;
  keyNo: string;
  keyMeta: string;
}

export class GamebullInventorySource implements InventorySource {
  readonly name = 'gamebull';
  constructor(private redis: RedisLike, private opts: GamebullSourceOpts) {}

  async poll(spot: number, sigmaPerSec: number, nowTs: number): Promise<AggregateInventory> {
    const o = this.opts;
    // discover active LMSR markets from the YES-quantity keys (no separate index).
    const yesKeys = await this.redis.keys(`${o.keyYes}*`);
    const markets: HedgeableMarket[] = [];
    let aggregateDelta = 0;
    let skipped = 0;

    for (const yk of yesKeys) {
      const marketId = yk.slice(o.keyYes.length);
      const meta = await this.readMeta(marketId);
      if (!meta || !o.hedgeableFeedIds.includes(meta.feedId) || meta.underlyingSymbol !== o.symbol) {
        skipped++;
        continue;
      }
      const tauSec = (meta.expiryTs - nowTs) / 1000;
      if (tauSec <= 0) {
        skipped++;
        continue;
      }
      const qYes = Number(await this.redis.get(yk)) || 0;
      const qNo = Number(await this.redis.get(`${o.keyNo}${marketId}`)) || 0;
      const { dpdS } = digitalProb(spot, meta.strike, sigmaPerSec, tauSec);
      const delta = (qYes - qNo) * dpdS;
      aggregateDelta += delta;
      markets.push({ marketId, underlyingSymbol: meta.underlyingSymbol, strike: meta.strike, expiryTs: meta.expiryTs, qYes, qNo, delta });
    }

    return { aggregateDelta, notionalUsdt: Math.abs(aggregateDelta) * spot, markets, skipped };
  }

  private async readMeta(marketId: string): Promise<MarketMeta | null> {
    const raw = await this.redis.get(`${this.opts.keyMeta}${marketId}`);
    if (!raw) return null;
    try {
      const m = JSON.parse(raw);
      if (typeof m?.strike !== 'number' || typeof m?.expiryTs !== 'number' || typeof m?.underlyingSymbol !== 'string') return null;
      return { underlyingSymbol: m.underlyingSymbol, strike: m.strike, expiryTs: m.expiryTs, feedId: Number(m.feedId) };
    } catch {
      return null;
    }
  }
}

// Empty source — boots the loop with no Redis dependency (hedges nothing).
export class EmptyInventorySource implements InventorySource {
  readonly name = 'empty';
  async poll(): Promise<AggregateInventory> {
    return { aggregateDelta: 0, notionalUsdt: 0, markets: [], skipped: 0 };
  }
}

// Connect to predictor Redis with ioredis (imported lazily so the module compiles
// without it). Also exposes the raw client for the spot read.
export async function connectPredictorRedis(host: string, port: number): Promise<RedisLike & { getRaw(k: string): Promise<string | null> }> {
  const spec = 'ioredis';
  const mod: any = await import(spec).catch(() => null);
  if (!mod) throw new Error('ioredis not installed — run `npm install`');
  const Redis = mod.default || mod;
  const r = new Redis({ host, port, maxRetriesPerRequest: 1, lazyConnect: false });
  return {
    get: (k: string) => r.get(k),
    keys: (p: string) => r.keys(p),
    getRaw: (k: string) => r.get(k),
  };
}
