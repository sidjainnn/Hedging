// Maker-first execution. Hedge FEES — not direction — are what make a
// full-size hedge uneconomic (architecture PDF §8.7), and maker is half the
// taker rate, so this path roughly doubles the hedge a given spread can fund.
//
// The risk it introduces is that a passive order does not fill. These tests pin
// the property that makes that safe: a maker miss or partial is ALWAYS completed
// by crossing within the same reconcile, so the hedge is never left short of
// target while the service still reports itself armed and healthy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hedger } from '../src/core/hedger.ts';
import type { ExecutionVenue, OrderResult, Side, VenueFilters } from '../src/venue/types.ts';

class SplitVenue implements ExecutionVenue {
  readonly name = 'split';
  position = 0;
  mark = 64000;
  filters: VenueFilters = { minQty: 0.001, minNotional: 5, stepSize: 0.001 };
  makerFillRatio = 1;          // fraction of a maker order that fills
  makerCalls = 0;
  takerCalls = 0;
  takerQty = 0;
  hasKeys() { return true; }
  async getMarkPrice() { return this.mark; }
  async getPositionUnits() { return this.position; }
  async getFilters() { return this.filters; }
  async makerOrder(side: Side, qty: number): Promise<OrderResult> {
    this.makerCalls++;
    const q = Math.floor((qty * this.makerFillRatio) / this.filters.stepSize) * this.filters.stepSize;
    this.position += side === 'BUY' ? q : -q;
    return { side, qty: q, avgPrice: this.mark, dryRun: false, maker: true };
  }
  async marketOrder(side: Side, qty: number): Promise<OrderResult> {
    this.takerCalls++; this.takerQty += qty;
    const q = Math.floor(qty / this.filters.stepSize) * this.filters.stepSize;
    this.position += side === 'BUY' ? q : -q;
    return { side, qty: q, avgPrice: this.mark, dryRun: false };
  }
}

const mk = (v: SplitVenue, preferMaker: boolean) =>
  new Hedger(v, { maxNotionalUsdt: 100_000_000, deadbandUsdt: 0, preferMaker, makerTimeoutMs: 1 }, true);

test('maker path is used when enabled, and taker when not', async () => {
  const a = new SplitVenue(); await mk(a, true).reconcile(1, a.mark);
  assert.equal(a.makerCalls, 1); assert.equal(a.takerCalls, 0);

  const b = new SplitVenue(); await mk(b, false).reconcile(1, b.mark);
  assert.equal(b.makerCalls, 0); assert.equal(b.takerCalls, 1);
});

test('a PARTIAL maker fill is completed by crossing, in the same reconcile', async () => {
  const v = new SplitVenue();
  v.makerFillRatio = 0.4;
  const h = mk(v, true);
  await h.reconcile(1, v.mark);
  assert.equal(v.makerCalls, 1, 'should have tried to post first');
  assert.equal(v.takerCalls, 1, 'should have crossed for the remainder');
  assert.ok(Math.abs(v.takerQty - 0.6) < 0.01, `expected ~0.6 crossed, got ${v.takerQty}`);
  assert.ok(Math.abs(v.position - 1) < 0.01, `hedge must reach target, got ${v.position}`);
});

test('a maker order that fills NOTHING still reaches target', async () => {
  const v = new SplitVenue();
  v.makerFillRatio = 0;
  const h = mk(v, true);
  await h.reconcile(1, v.mark);
  assert.ok(Math.abs(v.position - 1) < 0.01, `hedge must reach target, got ${v.position}`);
});

test('maker fills are charged the MAKER rate, not taker', async () => {
  const full = new SplitVenue(); full.makerFillRatio = 1;
  const hm = mk(full, true); await hm.reconcile(1, full.mark);

  const tak = new SplitVenue();
  const ht = mk(tak, false); await ht.reconcile(1, tak.mark);

  // maker is 2bps vs taker 4bps — an all-maker fill must cost about half.
  assert.ok(hm.feesPaid > 0 && ht.feesPaid > 0);
  const ratio = hm.feesPaid / ht.feesPaid;
  assert.ok(Math.abs(ratio - 0.5) < 0.05, `expected ~half the fee, got ratio ${ratio.toFixed(3)}`);
});

test('a venue with NO maker support falls back to taker rather than failing', async () => {
  // ExecutionVenue.makerOrder is optional; preferMaker must not assume it.
  // Note this needs a venue class that genuinely lacks the method — deleting it
  // off an instance does nothing, since it lives on the prototype.
  class NoMakerVenue extends SplitVenue {
    override makerOrder = undefined as any;
  }
  const v = new NoMakerVenue();
  const h = mk(v as unknown as SplitVenue, true);
  await h.reconcile(1, v.mark);
  assert.equal(v.makerCalls, 0, 'must not have attempted a maker order');
  assert.equal(v.takerCalls, 1);
  assert.ok(Math.abs(v.position - 1) < 0.01);
});
