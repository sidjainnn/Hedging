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
          const { p, dpdS, d2pdS2 } = digitalProb(spot, strike, sigma, tau);
          assert.ok(Number.isFinite(p), `p not finite @ spot=${spot} K=${strike} σ=${sigma} τ=${tau} → ${p}`);
          assert.ok(Number.isFinite(dpdS), `dpdS not finite @ spot=${spot} K=${strike} σ=${sigma} τ=${tau} → ${dpdS}`);
          assert.ok(Number.isFinite(d2pdS2), `d2pdS2 not finite @ spot=${spot} K=${strike} σ=${sigma} τ=${tau} → ${d2pdS2}`);
          assert.ok(p >= 0 && p <= 1, `p out of range: ${p}`);
          assert.ok(dpdS >= 0, `dpdS negative: ${dpdS}`);
        }
});

test('gamma flips sign across the strike (odd-shaped, not a fixed-sign bump like vanilla gamma)', () => {
  // Cross-market hedge ratios sized on |Γ| alone are unsafe without checking this —
  // see cross-market-hedging-research-plan.md §"sign/shape mismatch".
  const below = digitalProb(64800, 65000, 4e-5, 300);
  const above = digitalProb(65200, 65000, 4e-5, 300);
  assert.ok(below.d2pdS2 > 0, `below-strike gamma should be positive, got ${below.d2pdS2}`);
  assert.ok(above.d2pdS2 < 0, `above-strike gamma should be negative, got ${above.d2pdS2}`);
});

test('gamma magnitude blows up as τ→0 at FIXED relative moneyness (the O(1/τ) singularity)', () => {
  // The usable-gamma band itself is ~σ√τ wide (see cross-market-hedging-research-plan.md
  // §4.2) — a FIXED dollar offset from strike falls outside the band as τ shrinks and
  // gamma decays back toward 0 there, which is a different (correct, but distinct) effect.
  // To isolate the O(1/τ) blowup, hold the offset at a fixed FRACTION of σ√τ instead.
  const strike = 65000, sigma = 4e-5;
  const gammaAt = (tauSec: number) => {
    const band = sigma * Math.sqrt(tauSec);
    const spot = strike * (1 - 0.5 * band); // 0.5 band-widths below strike, at every τ
    return Math.abs(digitalProb(spot, strike, sigma, tauSec).d2pdS2);
  };
  const far = gammaAt(3600);
  const near = gammaAt(30);
  assert.ok(near > far * 10, `gamma should grow sharply as τ shrinks: far(τ=3600)=${far}, near(τ=30)=${near}`);
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
