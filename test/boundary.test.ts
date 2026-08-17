// Boundary-value analysis (per standard QA technique: test AT the threshold and
// on both sides, and counts at 0/1/2/many). Threshold off-by-ones are a classic
// production bug class — a gate that arms one tick late or churns at the edge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gate } from '../src/core/gate.ts';
import { Hedger } from '../src/core/hedger.ts';
import { GamebullInventorySource } from '../src/inventory/gamebull.ts';
import type { RedisLike } from '../src/inventory/types.ts';
import type { ExecutionVenue, OrderResult, Side, VenueFilters } from '../src/venue/types.ts';

const gopts = { volGate: false, volThreshold: 0.0002, volHysteresis: 0.6, mode: 'fixed' as const, notionalFloor: 100, pctl: 0.6 };

// ── Gate arm boundary: floor = 100 (arms on >=) ──────────────────────────────
test('BVA gate arm: 99.99 idle, 100.00 arms, 100.01 arms', () => {
  assert.equal(new Gate(gopts).update(0, 99.99, true).armed, false, 'just below floor: idle');
  assert.equal(new Gate(gopts).update(0, 100.0, true).armed, true, 'exactly floor: arms (>=)');
  assert.equal(new Gate(gopts).update(0, 100.01, true).armed, true, 'just above floor: arms');
});

// ── Gate disarm hysteresis boundary: 0.6×100 = 60 (disarms on <) ─────────────
test('BVA gate disarm: at 60.00 stays armed, at 59.99 disarms', () => {
  const g = new Gate(gopts);
  g.update(0, 200, true); // arm first
  assert.equal(g.update(0, 60.0, true).armed, true, 'exactly 0.6× floor: stays armed (<)');
  assert.equal(g.update(0, 59.99, true).armed, false, 'just below: disarms');
});

// ── Hedger deadband boundary: 75 (skips on <) ────────────────────────────────
class MockVenue implements ExecutionVenue {
  readonly name = 'mock'; position = 0; mark = 63000; filters: VenueFilters = { minQty: 0.001, minNotional: 5, stepSize: 0.001 };
  orders: unknown[] = [];
  hasKeys() { return true; }
  async getMarkPrice() { return this.mark; }
  async getPositionUnits() { return this.position; }
  async getFilters() { return this.filters; }
  async marketOrder(side: Side, qty: number): Promise<OrderResult> {
    const q = Math.floor(qty / this.filters.stepSize) * this.filters.stepSize;
    if (q < this.filters.minQty) return { side, qty: 0, avgPrice: 0, dryRun: false };
    this.position += side === 'BUY' ? q : -q; this.orders.push({ side, q }); return { side, qty: q, avgPrice: this.mark, dryRun: false };
  }
}

test('BVA deadband: move just under $75 skips, exactly $75 fires', async () => {
  // target notional just under deadband → no order
  const a = new MockVenue();
  await new Hedger(a, { maxNotionalUsdt: 1e6, deadbandUsdt: 75 }, true).reconcile(74.9 / 63000, 63000);
  assert.equal(a.orders.length, 0, 'under deadband: skipped');
  // exactly at deadband → fires (guard is strict <)
  const b = new MockVenue();
  await new Hedger(b, { maxNotionalUsdt: 1e6, deadbandUsdt: 75 }, true).reconcile(75.01 / 63000, 63000);
  assert.equal(b.orders.length, 1, 'at/above deadband: order fires');
});

// ── Count boundaries: 0 / 1 / 2 / many active markets ────────────────────────
const NOW = 1_000_000_000_000;
const META = JSON.stringify({ underlyingSymbol: 'BTCUSDT', strike: 63000, expiryTs: NOW + 300_000, feedId: 3 });
function invWith(n: number) {
  const store: Record<string, string> = {};
  const active: string[] = [];
  for (let i = 0; i < n; i++) { active.push('m' + i); store['Y_m' + i] = '100'; store['N_m' + i] = '0'; store['M_m' + i] = META; }
  const redis: RedisLike = { get: async (k) => store[k] ?? null, smembers: async () => active };
  return new GamebullInventorySource(redis, { symbol: 'BTCUSDT', hedgeableFeedIds: [3], activeMarketsKey: 'a', keyYes: 'Y_', keyNo: 'N_', keyMeta: 'M_' });
}

test('BVA market count: 0 → flat, 1 → one, 2 → sums, no crash at any count', async () => {
  assert.equal((await invWith(0).poll(63000, 4e-5, NOW)).markets.length, 0);
  assert.equal((await invWith(0).poll(63000, 4e-5, NOW)).aggregateDelta, 0, '0 markets → zero delta');
  assert.equal((await invWith(1).poll(63000, 4e-5, NOW)).markets.length, 1);
  const two = await invWith(2).poll(63000, 4e-5, NOW);
  assert.equal(two.markets.length, 2);
  assert.ok(two.aggregateDelta > 0, 'two same-side markets sum');
});

// ── Expiry boundary: τ at exactly 0 vs 1ms left ──────────────────────────────
test('BVA expiry lockout: inside the window skipped, outside it hedged', async () => {
  const LOCKOUT = 20;
  const mk = (expiryTs: number) => {
    const store = { Y_m: '100', N_m: '0', M_m: JSON.stringify({ underlyingSymbol: 'BTCUSDT', strike: 63000, expiryTs, feedId: 3 }) } as Record<string, string>;
    const redis: RedisLike = { get: async (k) => store[k] ?? null, smembers: async () => ['m'] };
    return new GamebullInventorySource(redis, {
      symbol: 'BTCUSDT', hedgeableFeedIds: [3], activeMarketsKey: 'a', keyYes: 'Y_', keyNo: 'N_', keyMeta: 'M_',
      minTauSec: 60, expiryLockoutSec: LOCKOUT,
    });
  };
  // Previously "1ms left" was hedged. That is the gamma wall: dp/dS diverges as
  // τ→0, so a ~4k-contract book demanded ~88 BTC ($5.8M) of hedge in the final
  // second — rejected by the venue and pointless anyway, since the position
  // settles moments later. Inside the lockout we deliberately stop hedging.
  assert.equal((await mk(NOW).poll(63000, 4e-5, NOW)).markets.length, 0, 'τ=0 skipped');
  assert.equal((await mk(NOW + 1).poll(63000, 4e-5, NOW)).markets.length, 0, '1ms left: inside lockout, skipped');
  assert.equal((await mk(NOW + LOCKOUT * 1000).poll(63000, 4e-5, NOW)).markets.length, 0, 'exactly at lockout: skipped');
  assert.equal((await mk(NOW + (LOCKOUT + 1) * 1000).poll(63000, 4e-5, NOW)).markets.length, 1, 'just outside lockout: hedged');
});

test('gamma wall: delta stays bounded as τ→0 (τ floored for the delta calc)', async () => {
  const mk = (expiryTs: number) => {
    const store = { Y_m: '4000', N_m: '0', M_m: JSON.stringify({ underlyingSymbol: 'BTCUSDT', strike: 63000, expiryTs, feedId: 3 }) } as Record<string, string>;
    const redis: RedisLike = { get: async (k) => store[k] ?? null, smembers: async () => ['m'] };
    return new GamebullInventorySource(redis, {
      symbol: 'BTCUSDT', hedgeableFeedIds: [3], activeMarketsKey: 'a', keyYes: 'Y_', keyNo: 'N_', keyMeta: 'M_',
      minTauSec: 60, expiryLockoutSec: 20,
    });
  };
  // ATM, 4000 contracts: unfloored this explodes (60+ BTC at τ=1s). Floored at
  // 60s it must stay at the τ=60s value no matter how little time is left.
  const at300 = (await mk(NOW + 300_000).poll(63000, 4e-5, NOW)).aggregateDelta;
  const at60 = (await mk(NOW + 60_000).poll(63000, 4e-5, NOW)).aggregateDelta;
  const at21 = (await mk(NOW + 21_000).poll(63000, 4e-5, NOW)).aggregateDelta;
  assert.ok(Number.isFinite(at21), 'delta finite near expiry');
  assert.ok(at21 > at300, 'delta still grows as expiry nears (up to the floor)');
  assert.ok(Math.abs(at21 - at60) < 1e-9, 'delta clamped at the τ-floor value, not diverging');
});
