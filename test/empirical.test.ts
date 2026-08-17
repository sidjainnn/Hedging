// Tests for the empirical-curve delta — the curve the exchange actually quotes
// on, and (since this change) the one that sizes the hedge.
//
// Two jobs here:
//   1. Pin the breakpoints against gb-crypto-local/drivers/lib/pricing.mjs. If
//      that file's curve moves and this one does not, the hedge silently goes
//      back to being sized off a curve we no longer quote — the exact bug this
//      module was written to fix, and one that would NOT fail loudly.
//   2. Assert the numerical derivative is finite and sane everywhere, including
//      the degenerate states that actually occur (bad feed, expiry, zero vol).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { empiricalProbYes, empiricalDigital } from '../src/core/empirical.ts';
import { digitalProb } from '../src/core/digital.ts';

const SIG = 4e-5;

test('curve matches pricing.mjs at the pinned breakpoints', () => {
  // At tau = refSec (300) the time scaling is 1, so scaled% == raw%.
  // strike chosen so a given % offset is exact.
  const K = 100000;
  const at = (pct: number) => empiricalProbYes(K * (1 + pct / 100), K, 300);
  assert.equal(Math.round(at(0.000) * 1000) / 1000, 0.5);
  assert.equal(Math.round(at(0.005) * 1000) / 1000, 0.5);
  assert.equal(Math.round(at(0.02) * 1000) / 1000, 0.55);
  assert.equal(Math.round(at(0.05) * 1000) / 1000, 0.65);
  assert.equal(Math.round(at(0.10) * 1000) / 1000, 0.8);
  assert.equal(Math.round(at(0.15) * 1000) / 1000, 0.94);
  // clamped at 0.99
  assert.equal(Math.round(at(0.30) * 1000) / 1000, 0.99);
  // symmetric below the strike
  assert.equal(Math.round(at(-0.05) * 1000) / 1000, 0.35);
});

test('delta is finite and non-negative across degenerate inputs', () => {
  for (const spot of [0, -1, NaN, Infinity, 1e-9, 1, 63000, 1e9]) {
    for (const strike of [0, NaN, 1, 63000, 1e9]) {
      for (const tau of [-10, 0, 1e-9, 1, 60, 300, 1e7]) {
        for (const sig of [0, 1e-12, SIG, 1e6]) {
          const { p, dpdS, d2pdS2 } = empiricalDigital(spot, strike, sig, tau);
          assert.ok(Number.isFinite(p) && p >= 0 && p <= 1, `p ${p}`);
          assert.ok(Number.isFinite(dpdS), `dpdS ${dpdS}`);
          assert.ok(Number.isFinite(d2pdS2), `d2pdS2 ${d2pdS2}`);
          // A YES digital is monotone increasing in spot — delta is never negative.
          assert.ok(dpdS >= 0, `dpdS negative: ${dpdS}`);
        }
      }
    }
  }
});

test('the ATM dead zone does NOT produce a zero hedge', () => {
  // The curve is exactly flat within |scaled delta| <= 0.005%, so its POINTWISE
  // derivative at the money is zero. That would mean "no hedge needed" at the
  // point of maximum risk. The finite bandwidth is what prevents it — this test
  // is the reason the derivative is numerical rather than analytic.
  const S = 63900;
  const { dpdS } = empiricalDigital(S, S, SIG, 150);
  assert.ok(dpdS > 0, `ATM delta collapsed to ${dpdS}`);
});

test('empirical delta is materially below Black-Scholes, worst at the money', () => {
  // The measured defect this module fixes. Not asserting exact ratios (they move
  // with the bandwidth), only the DIRECTION and that ATM is the worst case —
  // which is what makes the old BS sizing an over-hedge rather than a wash.
  const S = 63900;
  const tau = 150;
  const atm = digitalProb(S, S, SIG, tau).dpdS / empiricalDigital(S, S, SIG, tau).dpdS;
  const otm = digitalProb(S, S - 40, SIG, tau).dpdS / empiricalDigital(S, S - 40, SIG, tau).dpdS;
  assert.ok(atm > 1.5, `expected BS to overstate ATM delta, ratio ${atm}`);
  assert.ok(atm > otm, `expected the gap to be worst ATM (atm ${atm} vs otm ${otm})`);
});

test('delta grows as expiry approaches at fixed moneyness', () => {
  // Same qualitative shape as the digital it approximates: less time to revert
  // means a given move carries more certainty.
  const S = 63900;
  const K = S - 20;
  const far = empiricalDigital(S, K, SIG, 300).dpdS;
  const near = empiricalDigital(S, K, SIG, 60).dpdS;
  assert.ok(near > far, `expected delta to rise into expiry: ${near} vs ${far}`);
});
