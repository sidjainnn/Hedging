// Delta and gamma of the EMPIRICAL pricing curve — the curve BitBull actually
// quotes on (`empiricalProbYes` in gb-crypto-local/drivers/lib/pricing.mjs).
//
// WHY THIS FILE EXISTS
// --------------------
// Until now this service sized its hedge from `digitalProb`'s Black-Scholes
// dp/dS while the exchange quoted off the empirical curve. Those are different
// curves, so the hedge was sized against a sensitivity the book does not have.
// Measured against 78 live spot moves >= $2 in data/driver.log, the exchange's
// observed d(fairYes)/d(spot) was roughly HALF what BS claimed, and the gap
// widened into expiry:
//
//     tau        observed (empirical)   BS (what we hedged on)   over-hedge
//     200-300s   0.55 c/$               0.90 c/$                 1.6x
//     100-200s   0.68 c/$               1.27 c/$                 1.9x
//     < 100s     0.93 c/$               2.02 c/$                 2.2x
//
// and at the money the disagreement is 3.15x. Hedging a delta the quotes do not
// have costs fees and slippage to ADD variance. This is the same defect class as
// the pre-launch bug where P&L was accounted in BS while quoting in empirical —
// that one was caught, this one was not.
//
// WHY NUMERICAL, NOT ANALYTIC
// ---------------------------
// The empirical curve is piecewise-linear, so its exact derivative is a step
// function: discontinuous at every breakpoint, and EXACTLY ZERO inside the flat
// [0.000%, 0.005%] segment around the strike. Using it directly would be wrong
// twice over — the hedge would jump discontinuously as spot crossed a knot
// (churning fees on a fit artifact), and it would fall to zero at the money,
// which is precisely where the book carries most risk.
//
// The kinks are artifacts of fitting a smooth function with straight segments;
// they are not a real property of BTC. So we take a CENTRAL DIFFERENCE over a
// finite bandwidth h, which averages the slope across the region spot will
// plausibly visit before the next rebalance. That is also the variance-minimising
// hedge ratio for a curve with kinks: E[dp]/E[dS] over the local distribution,
// not the pointwise tangent.
//
// h is anchored to the remaining expected move (sigma*sqrt(tau)) with a dollar
// floor. NOTE: sigmaPerSec enters ONLY as a smoothing bandwidth here, never as
// the curve's shape — so the known SIGMA_PER_SEC miscalibration (4e-5 ~ 22.5%
// annualised, against realistic BTC vol of 40-60%) is second-order for this
// path, unlike for `digitalProb` where it drives the answer directly.

import type { Digital } from './digital.js';

// Mirrors EMPIRICAL_BREAKPOINTS in gb-crypto-local/drivers/lib/pricing.mjs.
// [ |scaled delta%| from strike, YES probability % ]
//
// PROVENANCE (carried over verbatim in spirit from that file — do not lose it):
// reverse-engineered from live-observed POLYMARKET trading by a THIRD PARTY (a
// bot-builder's public write-up), NOT Polymarket's own published spec. Treat as
// a starting calibration, not verified ground truth. The final [0.30, 99] point
// is our own shallow extrapolation, not an observation.
//
// KEEP IN SYNC. If pricing.mjs's breakpoints change and these do not, the hedge
// silently reverts to being sized off a curve the exchange no longer quotes —
// the exact bug this file was written to fix. See test/empirical.test.ts, which
// pins these values.
const EMPIRICAL_BREAKPOINTS: ReadonlyArray<readonly [number, number]> = [
  [0.000, 50], [0.005, 50], [0.02, 55], [0.05, 65], [0.10, 80], [0.15, 94], [0.30, 99],
];

const REF_SEC = 300;   // the breakpoints' assumed reference window (see pricing.mjs)
const MIN_TAU = 5;     // same floor pricing.mjs applies

function piecewiseLerp(x: number, points: ReadonlyArray<readonly [number, number]>): number {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return 50;
  if (x <= first[0]) return first[1];
  for (let i = 1; i < points.length; i++) {
    const lo = points[i - 1];
    const hi = points[i];
    if (!lo || !hi) break;
    if (x <= hi[0]) {
      const [x0, y0] = lo;
      const [x1, y1] = hi;
      return x1 === x0 ? y1 : y0 + (y1 - y0) * (x - x0) / (x1 - x0);
    }
  }
  return last[1];
}

// Exact port of empiricalProbYes(). Returns probability in [0.01, 0.99].
export function empiricalProbYes(spot: number, strike: number, tauSec: number, refSec = REF_SEC): number {
  const tau = Math.max(tauSec, MIN_TAU);
  const rawDeltaPct = ((spot - strike) / strike) * 100;
  const scaledDeltaPct = rawDeltaPct * Math.sqrt(refSec / tau);
  const prob = piecewiseLerp(Math.abs(scaledDeltaPct), EMPIRICAL_BREAKPOINTS);
  const yes = scaledDeltaPct >= 0 ? prob : 100 - prob;
  return Math.min(0.99, Math.max(0.01, yes / 100));
}

export interface EmpiricalDeltaOpts {
  // Central-difference bandwidth as a multiple of the remaining expected move
  // (spot * sigmaPerSec * sqrt(tau)). Larger = smoother hedge, less kink chatter,
  // but more averaging away of genuine local convexity.
  bumpSigmaFrac?: number;
  // Absolute dollar floor on the bandwidth, so the ATM flat segment is always
  // straddled even when sigma*sqrt(tau) collapses near expiry.
  bumpMinUsd?: number;
}

export const DEFAULT_BUMP_SIGMA_FRAC = 0.5;
export const DEFAULT_BUMP_MIN_USD = 5;

// Same {p, dpdS, d2pdS2} shape as digitalProb, so this is a drop-in replacement
// at the call site in inventory/gamebull.ts.
export function empiricalDigital(
  spot: number,
  strike: number,
  sigmaPerSec: number,
  tauSec: number,
  opts: EmpiricalDeltaOpts = {},
): Digital {
  // Same degenerate-input guard as digitalProb: a bad feed returns a neutral
  // price and ZERO sensitivity rather than NaN, so it can never size a hedge.
  if (!(spot > 0) || !(strike > 0) || !Number.isFinite(spot) || !Number.isFinite(strike)) {
    return { p: 0.5, dpdS: 0, d2pdS2: 0 };
  }
  const tau = Math.max(tauSec, MIN_TAU);
  const vol = Math.max(sigmaPerSec, 1e-12);
  const frac = opts.bumpSigmaFrac ?? DEFAULT_BUMP_SIGMA_FRAC;
  const floor = opts.bumpMinUsd ?? DEFAULT_BUMP_MIN_USD;

  const h = Math.max(floor, spot * vol * Math.sqrt(tau) * frac);

  const p = empiricalProbYes(spot, strike, tau);
  const pUp = empiricalProbYes(spot + h, strike, tau);
  const pDn = empiricalProbYes(spot - h, strike, tau);

  const dpdS = (pUp - pDn) / (2 * h);
  const d2pdS2 = (pUp - 2 * p + pDn) / (h * h);

  return {
    p,
    dpdS: Number.isFinite(dpdS) ? dpdS : 0,
    d2pdS2: Number.isFinite(d2pdS2) ? d2pdS2 : 0,
  };
}
