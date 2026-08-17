// HEDGE_FRACTION: the lever that keeps hedge fees inside what the spread earns.
//
// Hedge fees scale with PERP notional while revenue scales with BINARY notional,
// and the two differ by ~300x, so a full-delta hedge costs more than the spread
// earns (architecture PDF §8.7). This scales the target down. The tests below
// pin the two properties that matter: the scaling is applied, and an ABSENT or
// malformed setting can never silently disable hedging.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Loop } from '../src/loop.ts';
import { Hedger } from '../src/core/hedger.ts';
import { Gate } from '../src/core/gate.ts';
import { DryRunVenue } from '../src/venue/dry-run.ts';
import type { AggregateInventory, InventorySource } from '../src/inventory/types.ts';

// Fixed inventory, so the only thing varying between runs is the fraction.
class FixedInventory implements InventorySource {
  readonly name = 'fixed';
  constructor(private delta: number) {}
  async poll(): Promise<AggregateInventory> {
    return {
      aggregateDelta: this.delta,
      notionalUsdt: Math.abs(this.delta) * 64000,
      netContractsYes: 1786, grossContracts: 1786,
      deltaCurve: 'empirical',
      markets: [], skipped: 0,
    };
  }
}

async function runOnce(hedgeFraction: number | undefined) {
  const venue = new DryRunVenue();
  const hedger = new Hedger(venue, { maxNotionalUsdt: 100_000_000, deadbandUsdt: 0 }, true);
  const loop = new Loop({
    symbol: 'BTCUSDT',
    getSpot: async () => 64000,
    inventory: new FixedInventory(2),      // 2 BTC of aggregate delta
    // Gate forced permanently ARMED: this test is about hedge SIZING, so the
    // gate must never be the reason a position differs between runs.
    gate: new Gate({ volGate: false, volThreshold: 1e9, volHysteresis: 1, mode: 'fixed', notionalFloor: 0, pctl: 0.5 }),
    hedger, venue,
    volWindow: 2, minSigmaPerSec: 4e-5,
    deadbandTightUsdt: 0, deadbandLooseUsdt: 0, deadbandRefSec: 300,
    ...(hedgeFraction === undefined ? {} : { hedgeFraction }),
  } as any);
  // A few ticks so the vol window fills and the gate can arm.
  for (let i = 0; i < 4; i++) await loop.tick();
  return (loop as any).state;
}

test('hedge target is scaled by HEDGE_FRACTION', async () => {
  const full = await runOnce(1);
  const third = await runOnce(0.3);
  assert.ok(Math.abs(full.hedger.livePosition) > 0, 'full hedge should take a position');
  const ratio = Math.abs(third.hedger.livePosition) / Math.abs(full.hedger.livePosition);
  assert.ok(Math.abs(ratio - 0.3) < 0.02, `expected ~0.30x position, got ${ratio.toFixed(3)}`);
  assert.equal(third.hedgeFraction, 0.3, 'state must report the fraction actually applied');
});

test('fraction 0 means no hedge at all', async () => {
  const s = await runOnce(0);
  assert.equal(s.hedger.livePosition, 0);
  assert.equal(s.hedgeFraction, 0);
});

test('an ABSENT fraction defaults to full delta, never to zero', async () => {
  // The dangerous failure mode: a missing setting silently disabling the hedge
  // while the service still reports itself healthy and armed.
  const absent = await runOnce(undefined);
  const full = await runOnce(1);
  assert.equal(absent.hedgeFraction, 1);
  assert.equal(absent.hedger.livePosition, full.hedger.livePosition);
});

test('out-of-range fractions are clamped, not trusted', async () => {
  const over = await runOnce(5);
  const under = await runOnce(-2);
  const full = await runOnce(1);
  assert.equal(over.hedgeFraction, 1, 'above 1 clamps to full delta, never amplifies');
  assert.equal(over.hedger.livePosition, full.hedger.livePosition);
  assert.equal(under.hedgeFraction, 0, 'negative clamps to 0, never flips the hedge sign');
  assert.equal(under.hedger.livePosition, 0);
});
