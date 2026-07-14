// Hedger: position cap clamp, deadband, reduce-only, min-notional, flatten, and
// exact P&L. These guard the money-moving path — a clamp failure at scale is an
// oversized position; a P&L sign error mis-reports the whole hedge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hedger } from '../src/core/hedger.ts';
import type { ExecutionVenue, OrderResult, Side, VenueFilters } from '../src/venue/types.ts';

class MockVenue implements ExecutionVenue {
  readonly name = 'mock';
  position = 0;
  mark = 63000;
  keys = true;
  filters: VenueFilters = { minQty: 0.001, minNotional: 5, stepSize: 0.001 };
  orders: { side: Side; qty: number; reduceOnly: boolean }[] = [];
  hasKeys() { return this.keys; }
  async getMarkPrice() { return this.mark; }
  async getPositionUnits() { return this.position; }
  async getFilters() { return this.filters; }
  async marketOrder(side: Side, qty: number, reduceOnly: boolean): Promise<OrderResult> {
    const q = Math.floor(qty / this.filters.stepSize) * this.filters.stepSize;
    if (q < this.filters.minQty) return { side, qty: 0, avgPrice: 0, dryRun: false };
    this.position += side === 'BUY' ? q : -q;
    this.orders.push({ side, qty: q, reduceOnly });
    return { side, qty: q, avgPrice: this.mark, dryRun: false };
  }
}

const mk = (v: MockVenue, deadband = 75) => new Hedger(v, { maxNotionalUsdt: 10_000, deadbandUsdt: deadband }, true);

test('position is CLAMPED to the notional cap even when target is huge', async () => {
  const v = new MockVenue();
  const h = mk(v);
  await h.reconcile(10 /* BTC, way over budget */, 63000);
  const notional = Math.abs(v.position * 63000);
  assert.ok(notional <= 10_000 + 1, `position notional ${notional} exceeds cap`);
  assert.ok(v.position > 0, 'went long toward the (clamped) target');
});

test('deadband suppresses tiny target wobbles (no fee churn)', async () => {
  const v = new MockVenue();
  const h = mk(v);
  await h.reconcile(0.0005 /* ~$31, under $75 deadband */, 63000);
  assert.equal(v.orders.length, 0, 'no order fired inside the deadband');
});

test('reduce-only is set when moving toward zero; flatten closes fully', async () => {
  const v = new MockVenue();
  const h = mk(v);
  await h.reconcile(0.15, 63000); // open long ~$9.5k (> deadband)
  assert.ok(v.position > 0);
  await h.reconcile(0.05, 63000); // reduce toward zero
  assert.equal(v.orders.at(-1)!.reduceOnly, true, 'reducing order must be reduce-only');
  await h.flatten(63000);
  assert.ok(Math.abs(v.position) < v.filters.minQty, `flatten should reach ~0, got ${v.position}`);
});

test('disabled hedger places nothing', async () => {
  const v = new MockVenue();
  const h = mk(v);
  h.setEnabled(false);
  await h.reconcile(0.15, 63000);
  assert.equal(v.orders.length, 0);
});

test('no-keys venue is observe-only (no orders)', async () => {
  const v = new MockVenue();
  v.keys = false;
  const h = mk(v);
  await h.reconcile(0.15, 63000);
  assert.equal(v.orders.length, 0);
});

test('hedge P&L is exact and correctly signed', async () => {
  const v = new MockVenue();
  const h = mk(v);
  await h.reconcile(0.1, 63000); // long 0.1 BTC @ 63000
  assert.ok(Math.abs(h.hedgePnl(63000)) < 1e-6, 'flat P&L at entry mark');
  // spot +1000 on a LONG ⇒ +100 (0.1 × 1000)
  assert.ok(Math.abs(h.hedgePnl(64000) - 100) < 5, `expected ~+100, got ${h.hedgePnl(64000)}`);
  // spot −1000 ⇒ −100
  assert.ok(Math.abs(h.hedgePnl(62000) + 100) < 5, `expected ~−100, got ${h.hedgePnl(62000)}`);
});

test('accumulated P&L stays finite over many reconciles (no float blowup)', async () => {
  const v = new MockVenue();
  const h = mk(v, 1); // small deadband so orders actually fire
  for (let i = 0; i < 2000; i++) {
    v.mark = 63000 + Math.sin(i / 10) * 500;
    await h.reconcile(Math.sin(i / 7) * 0.1, v.mark);
  }
  assert.ok(Number.isFinite(h.hedgePnl(v.mark)), 'P&L finite after 2000 reconciles');
  assert.ok(Number.isFinite(h.feesPaid) && h.feesPaid >= 0, 'fees finite & non-negative');
});
