// Inventory source abstraction. The hedger doesn't care WHERE the net directional
// exposure comes from — GameBull's live LMSR inventory in predictor Redis, or a
// test stub. Both produce the same AggregateInventory shape, so the gate / hedger
// / loop consume either unchanged.

// Minimal Redis surface we depend on — dependency-injected so the adapter is
// unit-testable against an in-memory stub (no infra) and wired to real ioredis
// only at runtime.
export interface RedisLike {
  get(key: string): Promise<string | null>;
  keys(pattern: string): Promise<string[]>;
}

export interface MarketMeta {
  underlyingSymbol: string;
  strike: number;
  expiryTs: number; // ms epoch
  feedId: number;
}

// One hedgeable market read from GameBull (crypto/feed-3 only — a market with a
// tradeable underlying, strike and expiry).
export interface HedgeableMarket {
  marketId: string;
  underlyingSymbol: string;
  strike: number;
  expiryTs: number;
  qYes: number;
  qNo: number;
  delta: number; // (qYes−qNo)·dp/dS — this market's contribution to the aggregate
}

export interface AggregateInventory {
  // net BTC-equivalent settlement-value delta for the hedge symbol (the hedger
  // holds this many units so a BTC move offsets the book).
  aggregateDelta: number;
  notionalUsdt: number; // |aggregateDelta| · spot
  markets: HedgeableMarket[];
  skipped: number; // markets seen but not hedgeable (no meta / wrong feed / expired)
}

export interface InventorySource {
  readonly name: string;
  // spot = live underlying price; sigmaPerSec = realized vol per second; nowTs = ms epoch.
  poll(spot: number, sigmaPerSec: number, nowTs: number): Promise<AggregateInventory>;
}
