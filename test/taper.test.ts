import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linearTaper } from '../src/core/taper.ts';

test('linearTaper: at full time remaining -> early value, at expiry -> late value', () => {
  assert.equal(linearTaper(300, 300, 125, 400), 125, 'tauHat=1 -> early (tight)');
  assert.equal(linearTaper(0, 300, 125, 400), 400, 'tauHat=0 -> late (loose)');
});

test('linearTaper: monotonic and linear across the window (deadband GROWS as expiry nears)', () => {
  const half = linearTaper(150, 300, 125, 400);
  assert.equal(half, 262.5, 'tauHat=0.5 -> exact midpoint');
  const q1 = linearTaper(225, 300, 125, 400); // tauHat=0.75
  const q3 = linearTaper(75, 300, 125, 400);  // tauHat=0.25
  assert.ok(q1 < half && half < q3, 'strictly increases as tau shrinks (loosens toward expiry)');
});

test('linearTaper: also supports the OPPOSITE direction (early < late), as ammBForTau uses on the quoting side', () => {
  // Same helper, decay downward instead of growing — mirrors quoting.mjs's
  // ammBForTau(tau, bMax, bMin) shape, just parameterized the other way.
  assert.equal(linearTaper(300, 300, 12500, 1500), 12500);
  assert.equal(linearTaper(0, 300, 12500, 1500), 1500);
});

test('linearTaper: clamps tau outside [0, refSec] instead of extrapolating', () => {
  assert.equal(linearTaper(-10, 300, 125, 400), 400, 'past expiry clamps to late, not beyond it');
  assert.equal(linearTaper(500, 300, 125, 400), 125, 'further out than refSec clamps to early, not below it');
});
