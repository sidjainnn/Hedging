// Linear time-taper, same shape as the quoting side's AMM b-decay
// (gb-crypto-local/drivers/lib/quoting.mjs ammBForTau) — reimplemented here
// since this is a separate deployable service with no shared package, not a
// copy-paste accident.
//
// tauHat=1 (far from expiry) -> `early`; tauHat=0 (at/after expiry) -> `late`.
// Works for EITHER direction — pass early > late to decay downward (as the
// AMM's b does) or early < late to grow upward (as the hedge deadband does):
// gamma is small far from expiry, so a real signal is cheap and worth
// reacting to fast (tight deadband); gamma is large near expiry, so chasing
// small moves there mostly buys fee churn on a position about to resolve
// itself (loosen off, or stop).
export function linearTaper(tauSec: number, refSec: number, early: number, late: number): number {
  const tauHat = Math.max(0, Math.min(1, tauSec / Math.max(refSec, 1e-9)));
  return late + (early - late) * tauHat;
}
