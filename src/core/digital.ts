// Digital (binary) option fair value + delta. Mirrors amm-hedging's sim/events
// digitalProb and gb-crypto-local's pricing.mjs — the house's YES contract pays
// on S_T ≥ K, and dp/dS is how its value moves per $1 of spot.

function normCdf(x: number): number {
  // Abramowitz-Stegun erf approximation
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

function normPdf(x: number): number {
  return 0.3989422804 * Math.exp((-x * x) / 2);
}

export interface Digital {
  p: number; // P(S_T ≥ K) under GBM drift 0
  dpdS: number; // digital delta dp/dS
}

// sigmaPerSec = per-second vol, tauSec = seconds to expiry.
export function digitalProb(spot: number, strike: number, sigmaPerSec: number, tauSec: number): Digital {
  const tau = Math.max(tauSec, 1e-9);
  const vol = Math.max(sigmaPerSec, 1e-12);
  const denom = vol * Math.sqrt(tau);
  const d = (Math.log(spot / strike) - 0.5 * vol * vol * tau) / denom;
  const p = Math.min(0.999999, Math.max(1e-6, normCdf(d)));
  const dpdS = normPdf(d) / (spot * denom);
  return { p, dpdS };
}
