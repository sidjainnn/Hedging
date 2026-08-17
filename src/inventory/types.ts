// Inventory source abstraction. The hedger doesn't care WHERE the net directional
// exposure comes from — GameBull's live LMSR inventory in predictor Redis, or a
// test stub. Both produce the same AggregateInventory shape, so the gate / hedger
// / loop consume either unchanged.

// Minimal Redis surface we depend on — dependency-injected so the adapter is
// unit-testable against an in-memory stub (no infra) and wired to real ioredis
// only at runtime.
//
// NOTE: we deliberately expose `smembers` (read the active-markets index) and NOT
// `keys`. Redis KEYS is O(N) over the whole keyspace and BLOCKS the server — on a
// shared production Redis with millions of keys that freezes every service each
// poll. Reading the active-markets set is O(active markets) and non-blocking.
export interface RedisLike {
  get(key: string): Promise<string | null>;
  smembers(key: string): Promise<string[]>;
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
  // Signed CONTRACT inventory (qYes−qNo): which side this market leans, in
  // contracts. Distinct from `delta`, which is what that lean is worth per $1
  // of BTC. Reporting one under the other's name is what made the Hedge Desk
  // show a $66.8M "skew" on ~$1,000 of user flow.
  netContracts: number;
  delta: number; // netContracts·dp/dS — this market's contribution to the aggregate
  gamma: number; // netContracts·d²p/dS² — this market's contribution to portfolio gamma
}

export interface AggregateInventory {
  // net BTC-equivalent settlement-value delta for the hedge symbol (the hedger
  // holds this many units so a BTC move offsets the book).
  aggregateDelta: number;
  notionalUsdt: number; // |aggregateDelta| · spot
  // ── inventory skew, in CONTRACTS (not dollars) ───────────────────────────
  // netContractsYes = Σ(qYes−qNo). Positive = book leans YES. This is the
  // desk's mental model of "skew": how many net contracts am I sided by, and
  // therefore what am I hedging to flatten.
  netContractsYes: number;
  // grossContracts = Σ|qYes−qNo|. Comparing gross to |net| shows how much of
  // the lean is genuinely directional vs offsetting across markets — a book
  // that is 10,000 gross but 200 net barely needs hedging.
  grossContracts: number;
  // Which curve sized the delta above ('empirical' = the curve we quote on).
  // Surfaced so a reader can never again be unsure which one produced a number.
  deltaCurve: 'empirical' | 'bs';
  markets: HedgeableMarket[];
  skipped: number; // markets seen but not hedgeable (no meta / wrong feed / expired)
}

export interface InventorySource {
  readonly name: string;
  // spot = live underlying price; sigmaPerSec = realized vol per second; nowTs = ms epoch.
  poll(spot: number, sigmaPerSec: number, nowTs: number): Promise<AggregateInventory>;
}
