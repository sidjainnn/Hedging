// Adversarial tests for the digital delta math. The delta feeds position sizing,
// so a NaN/Infinity here silently disables OR blows up the hedge. We assert the
// output is ALWAYS finite and sane across degenerate inputs (expiry, zero vol,
// zero/huge spot) — the states that actually occur near settlement or on a bad feed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digitalProb } from '../src/core/digital.ts';

const grid = {
  spot: [0, 1e-9, 1, 63000, 1e9],
  strike: [1, 63000, 1e9],
  sigma: [0, 1e-12, 1e-5, 4e-5, 0.01, 1e6],
  tau: [-10, 0, 1e-9, 1, 300, 1e7],
};

test('digitalProb output is always finite and p∈[0,1]', () => {
  for (const spot of grid.spot)
    for (const strike of grid.strike)
      for (const sigma of grid.sigma)
        for (const tau of grid.tau) {
          const { p, dpdS } = digitalProb(spot, strike, sigma, tau);
          assert.ok(Number.isFinite(p), `p not finite @ spot=${spot} K=${strike} σ=${sigma} τ=${tau} → ${p}`);
          assert.ok(Number.isFinite(dpdS), `dpdS not finite @ spot=${spot} K=${strike} σ=${sigma} τ=${tau} → ${dpdS}`);
          assert.ok(p >= 0 && p <= 1, `p out of range: ${p}`);
          assert.ok(dpdS >= 0, `dpdS negative: ${dpdS}`);
        }
});

test('ATM probability ≈ 0.5 and delta is positive/finite', () => {
  const { p, dpdS } = digitalProb(63000, 63000, 4e-5, 300);
  assert.ok(Math.abs(p - 0.5) < 0.05, `ATM p=${p}`);
  assert.ok(dpdS > 0 && Number.isFinite(dpdS), `ATM dpdS=${dpdS}`);
});

test('deep ITM→p≈1, deep OTM→p≈0, both with ~0 delta', () => {
  const itm = digitalProb(80000, 63000, 4e-5, 300);
  const otm = digitalProb(50000, 63000, 4e-5, 300);
  assert.ok(itm.p > 0.99, `ITM p=${itm.p}`);
  assert.ok(otm.p < 0.01, `OTM p=${otm.p}`);
  assert.ok(itm.dpdS < 1e-3 && otm.dpdS < 1e-3, 'tails should have tiny delta');
});

test('near-expiry ATM delta stays finite (does not blow to Infinity)', () => {
  // τ→0 at the strike is the pin-risk singularity; must not produce Infinity.
  const { dpdS } = digitalProb(63000, 63000, 4e-5, 1e-9);
  assert.ok(Number.isFinite(dpdS), `near-expiry ATM dpdS=${dpdS}`);
});
