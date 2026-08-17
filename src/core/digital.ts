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
  d2pdS2: number; // digital gamma d²p/dS²
}

// sigmaPerSec = per-second vol, tauSec = seconds to expiry.
export function digitalProb(spot: number, strike: number, sigmaPerSec: number, tauSec: number): Digital {
  // Degenerate inputs (no valid price/strike) have no computable delta — return a
  // neutral p and ZERO delta rather than NaN/Infinity, so a bad feed can never
  // poison the aggregate or size a garbage hedge.
  if (!(spot > 0) || !(strike > 0) || !Number.isFinite(spot) || !Number.isFinite(strike)) {
    return { p: 0.5, dpdS: 0, d2pdS2: 0 };
  }
  const tau = Math.max(tauSec, 1e-9);
  const vol = Math.max(sigmaPerSec, 1e-12);
  const denom = vol * Math.sqrt(tau);
  const d = (Math.log(spot / strike) - 0.5 * vol * vol * tau) / denom;
  const p = Math.min(0.999999, Math.max(1e-6, normCdf(d)));
  const dpdS = normPdf(d) / (spot * denom);
  // d1 = d2 + σ√τ in standard BS notation (this file's `d` is d2, `denom` is σ√τ).
  // Γ = -φ(d2)·d1 / (S²σ²τ) is the textbook form; this file's `d`/`p` convention
  // has the opposite overall sign baked in already (see dpdS above, which is
  // +φ(d)/(Sσ√τ) rather than the textbook -φ(d1)/(Sσ√τ) for a PUT), so gamma
  // is derived directly from dpdS by differentiating it w.r.t. spot rather than
  // copied from a textbook formula with an assumed sign — verified against the
  // known odd-around-strike shape in digital.test.ts, not assumed.
  const d1 = d + denom;
  const d2pdS2 = -normPdf(d) * d1 / (spot * spot * vol * vol * tau);
  return { p, dpdS: Number.isFinite(dpdS) ? dpdS : 0, d2pdS2: Number.isFinite(d2pdS2) ? d2pdS2 : 0 };
}
