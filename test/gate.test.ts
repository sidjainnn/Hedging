// Gate: arm/disarm, hysteresis (no flapping), adaptive percentile, merge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gate } from '../src/core/gate.ts';

const base = { volGate: false, volThreshold: 0.0002, volHysteresis: 0.6, mode: 'fixed' as const, notionalFloor: 100, pctl: 0.6 };

test('disabled → never armed, idleReason=disabled', () => {
  const g = new Gate(base);
  const s = g.update(0.01, 1e6, false);
  assert.equal(s.armed, false);
  assert.equal(s.idleReason, 'disabled');
});

test('inventory gate (fixed) arms above floor, disarms below 0.6× (hysteresis, no flap)', () => {
  const g = new Gate(base);
  assert.equal(g.update(0, 50, true).armed, false, 'below floor: idle');
  assert.equal(g.update(0, 150, true).armed, true, 'above floor: armed');
  assert.equal(g.update(0, 70, true).armed, true, 'in hysteresis band (0.6×100=60): stays armed');
  assert.equal(g.update(0, 50, true).armed, false, 'below 60: disarms');
});

test('vol gate gates independently and both must be open', () => {
  const g = new Gate({ ...base, volGate: true });
  // notional high (inv gate open) but vol below threshold → not armed
  assert.equal(g.update(0.0001, 1e6, true).idleReason, 'idle-vol');
  // vol crosses threshold → armed
  assert.equal(g.update(0.0003, 1e6, true).armed, true);
  // vol drops into hysteresis (0.6×0.0002=0.00012) → stays armed
  assert.equal(g.update(0.00015, 1e6, true).armed, true);
  // vol below hysteresis → disarms
  assert.equal(g.update(0.00005, 1e6, true).idleReason, 'idle-vol');
});

test('adaptive gate self-calibrates to the ~60th percentile after warmup', () => {
  const g = new Gate({ ...base, mode: 'adaptive', notionalFloor: 10, pctl: 0.6 });
  // feed 1000 samples spanning 0..999; the 60th percentile should land near ~600.
  let last = g.update(0, 0, true);
  for (let i = 0; i < 1000; i++) last = g.update(0, i, true);
  assert.ok(last.effectiveGate > 500 && last.effectiveGate < 700, `adaptive gate ≈600, got ${last.effectiveGate}`);
  assert.ok(last.effectiveGate >= 10, 'never below the floor');
});

test('adaptive gate never drops below the floor during warmup', () => {
  const g = new Gate({ ...base, mode: 'adaptive', notionalFloor: 250, pctl: 0.6 });
  const s = g.update(0, 10, true); // 1 sample, well under warmup
  assert.equal(s.effectiveGate, 250, 'warmup uses the floor');
});
