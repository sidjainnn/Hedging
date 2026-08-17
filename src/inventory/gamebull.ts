// GameBull inventory source — reads the house LMSR inventory the MMP publishes to
// predictor Redis and turns it into an aggregate settlement-value delta the hedger
// can neutralize. Read-only; never writes their Redis.
//
// See docs/inventory-contract.md for the exact keys/shapes.

import { digitalProb } from '../core/digital.js';
import { empiricalDigital } from '../core/empirical.js';
import type { AggregateInventory, HedgeableMarket, InventorySource, MarketMeta, RedisLike } from './types.js';

export interface GamebullSourceOpts {
  symbol: string; // hedge symbol, e.g. 'BTCUSDT' — only markets on this underlying
  hedgeableFeedIds: number[]; // e.g. [3] (non-sports)
  activeMarketsKey: string; // e.g. 'predictor_active_markets' (the live-market index)
  keyYes: string;
  keyNo: string;
  keyMeta: string;
  // ── gamma-wall guards ────────────────────────────────────────────────────
  // A digital's dp/dS diverges as τ→0 at the strike: the same book that needs
  // 3.5 BTC of hedge at τ=300s demands 60 BTC at τ=1s. That delta is real maths
  // but it is NOT tradeable — you cannot buy 88 BTC in the last second, and
  // trying just burns fees against a position that is about to resolve itself.
  // minTauSec floors τ in the delta calc so exposure stays finite; below
  // expiryLockoutSec we stop counting the market at all and let it settle.
  // Optional: omitting them falls back to the defaults below rather than
  // producing NaN deltas, which would silently skip EVERY market and disable
  // hedging with no error anywhere.
  minTauSec?: number;
  expiryLockoutSec?: number;
  // ── which curve sizes the hedge ──────────────────────────────────────────
  // 'empirical' (default) differentiates the SAME curve the exchange quotes on
  // (empiricalProbYes). 'bs' uses the Black-Scholes digital delta.
  //
  // This defaults to 'empirical' because 'bs' was measurably WRONG: the exchange
  // has quoted off the empirical curve since that curve replaced Black-Scholes,
  // but this service kept sizing off the BS derivative, over-hedging by ~1.6-2.2x
  // (3.15x at the money) against how quotes actually move. See core/empirical.ts
  // for the measurement table. 'bs' is retained ONLY as a rollback path.
  deltaCurve?: 'empirical' | 'bs';
}

export const DEFAULT_MIN_TAU_SEC = 60;
export const DEFAULT_EXPIRY_LOCKOUT_SEC = 20;
export const DEFAULT_DELTA_CURVE: 'empirical' | 'bs' = 'empirical';

// A finite, safe number or 0 — guards against NaN/Infinity from a malformed key
// poisoning the aggregate (which would silently disable OR blow up the hedge).
function safeNum(raw: string | null): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

export class GamebullInventorySource implements InventorySource {
  readonly name = 'gamebull';
  constructor(private redis: RedisLike, private opts: GamebullSourceOpts) {}

  async poll(spot: number, sigmaPerSec: number, nowTs: number): Promise<AggregateInventory> {
    const o = this.opts;
    // Read the active-market index (O(active markets), non-blocking) rather than a
    // KEYS scan of the whole keyspace. This is the only Redis-set read we do.
    const marketIds = await this.redis.smembers(o.activeMarketsKey);
    const markets: HedgeableMarket[] = [];
    let aggregateDelta = 0;
    let netContractsYes = 0;   // Σ(qYes−qNo) — signed inventory lean, in contracts
    let grossContracts = 0;    // Σ|qYes−qNo| — how much lean is offsetting vs additive
    let skipped = 0;

    for (const marketId of marketIds) {
      const meta = await this.readMeta(marketId);
      if (!meta || !o.hedgeableFeedIds.includes(meta.feedId) || meta.underlyingSymbol !== o.symbol) {
        skipped++;
        continue;
      }
      const tauSec = (meta.expiryTs - nowTs) / 1000;
      // Expiry lockout: inside the final seconds the position resolves itself.
      // Chasing its (diverging) delta can only lose fees on a hedge that has no
      // time left to pay off.
      const lockoutSec = Number.isFinite(o.expiryLockoutSec as number) ? (o.expiryLockoutSec as number) : DEFAULT_EXPIRY_LOCKOUT_SEC;
      if (tauSec <= lockoutSec) {
        skipped++;
        continue;
      }
      const qYes = safeNum(await this.redis.get(`${o.keyYes}${marketId}`));
      const qNo = safeNum(await this.redis.get(`${o.keyNo}${marketId}`));
      // Floor τ for the delta only. Past this point dp/dS is a mathematical
      // fiction — unhedgeable terminal gamma — so we deliberately under-report
      // rather than demand a hedge that cannot be executed.
      const minTau = Number.isFinite(o.minTauSec as number) ? (o.minTauSec as number) : DEFAULT_MIN_TAU_SEC;
      const tauForDelta = Math.max(tauSec, minTau);
      // Size the hedge off the curve the exchange actually QUOTES on. Using the
      // Black-Scholes derivative here while quoting empirical hedges a
      // sensitivity the book does not have — see core/empirical.ts.
      const curve = o.deltaCurve ?? DEFAULT_DELTA_CURVE;
      const { dpdS, d2pdS2 } = curve === 'bs'
        ? digitalProb(spot, meta.strike, sigmaPerSec, tauForDelta)
        : empiricalDigital(spot, meta.strike, sigmaPerSec, tauForDelta);
      // Signed contract inventory. This — not the dollar delta — is what "skew"
      // means to the desk: which side the book is leaning. Delta is how much
      // that lean COSTS per $1 of BTC; the two are different quantities and
      // conflating them under one label is a reporting bug, not a maths one.
      const netContracts = qYes - qNo;
      const delta = netContracts * dpdS;
      // Same τ floor as delta, same rationale (comment above): past the floor,
      // gamma is a mathematical fiction (unhedgeable terminal risk), so this is
      // a deliberate under-report, not a bug — Phase 0's analysis needs a
      // finite recorded series, not Infinity, right where it matters most.
      const gamma = netContracts * d2pdS2;
      if (!Number.isFinite(delta) || !Number.isFinite(gamma)) {
        skipped++;
        continue;
      }
      aggregateDelta += delta;
      netContractsYes += netContracts;
      grossContracts += Math.abs(netContracts);
      markets.push({ marketId, underlyingSymbol: meta.underlyingSymbol, strike: meta.strike, expiryTs: meta.expiryTs, qYes, qNo, netContracts, delta, gamma });
    }

    return {
      aggregateDelta,
      notionalUsdt: Math.abs(aggregateDelta) * spot,
      netContractsYes,
      grossContracts,
      deltaCurve: o.deltaCurve ?? DEFAULT_DELTA_CURVE,
      markets,
      skipped,
    };
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
    return {
      aggregateDelta: 0, notionalUsdt: 0,
      netContractsYes: 0, grossContracts: 0,
      deltaCurve: DEFAULT_DELTA_CURVE,
      markets: [], skipped: 0,
    };
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
    smembers: (k: string) => r.smembers(k),
    getRaw: (k: string) => r.get(k),
  };
}
