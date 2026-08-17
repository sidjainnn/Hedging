# Phase 0 results — pipeline smoke-test (NOT a feasibility conclusion)

Status: **pipeline verified working end-to-end, including a real bug caught and fixed during
verification.** The numbers below are from a short, manually-seeded run (multiple concurrent
markets across a genuine 5m/15m/1h tenor ladder, hand-placed trades) — enough to prove the
recorder and analysis script are correct, nowhere near enough sample to trust as a real go/no-go.
A genuine Phase 0 run needs organic multi-hour/multi-day collection under real user flow.

## Setup

- `market-generator`'s `TENOR_MS` was hardcoded to 5 minutes — parameterized to `TENOR_MIN` (env)
  so multiple tenors can run concurrently, matching the 15m/60m/5h ladder discussed earlier.
  `marketId`/`filterId` now derive from the tenor tag (`btc5m…`, `btc15m…`, `btc1h…`) instead of
  a hardcoded `btc5m…` prefix that would have been actively misleading for a 15m/1h market.
  Verified `STRIKE_ROUND_USD=10` stays well under 10% of the usable-gamma band at every tenor
  (5min: 8.4%, 15min: 4.9%, 60min: 2.4%, 300min: 1.1%) — no change needed there.
- Ran three concurrent `market-generator` loops (5m, 15m, 1h) alongside the hedging service with
  `RECORD_EXPOSURE=true`.
- Seeded deliberately **decorrelated, cross-tenor** flow: YES on the live 5m market, NO on the
  live 1h market, using fresh logged-in test users (raw unlogged-in userIds fail with
  "insufficient balance" — `bb_users` rows and their starting balance only exist after
  `POST /api/login`, not for an arbitrary numeric id).
- 687 rows recorded across multiple markets, including genuine 5m/15m/1h concurrency.

## A real bug caught during verification (not just a data-quality caveat)

The first run of `scripts/phase0-analysis.ts` reported **0.0% hedge availability for both
staggered and long-tenor candidates**, even at a tick with clearly-live, oppositely-signed
inventory on both a 5m and a 1h market simultaneously. That result looked suspiciously clean
rather than trusted at face value — manually checking the actual numbers at that tick found the
script's `band` calculation (`BAND_C · σ · √τ`) is a **fractional** (log-moneyness) width, but it
was being compared directly against a **dollar** distance (`|spot − strike|`) without multiplying
by spot to convert units. That guarantees `usable === false` on every real market (a ~0.001
fractional band can never exceed a multi-dollar gap), independent of whether real availability
existed. Fixed by multiplying the band by `other.spot` before comparing
([scripts/phase0-analysis.ts](../scripts/phase0-analysis.ts), "Measurement 2" section).

## Results, post-fix (`npx tsx scripts/phase0-analysis.ts`)

| Measurement | Result | Threshold | Verdict |
|---|---|---|---|
| [1] Gamma concentration (gross/net) | p50=1.02, p90=3.49 (n=61 ticks) | kill if p50<1.15 | FAIL |
| [2] Hedge availability — staggered same-tenor | 24.3% (n=70 high-γ moments) | kill if <30% | FAIL |
| [2] Hedge availability — long-tenor ladder | 30.0% | kill if <30% | PASS (borderline) |
| [3] Flow decorrelation (median \|corr\|) | 0.023 (n=2 market pairs) | kill if >0.8 | PASS |

**GO/NO-GO: NO-GO** (measurement 1 and the staggered leg of measurement 2 are kill conditions).

## Reading this honestly

- Sample sizes (61 ticks, 70 moments, 2 market pairs) are far too small for any of these numbers
  to be trustworthy on their own — this run's value is proving the **pipeline** computes correctly
  post-fix, not settling the actual research question.
- The long-tenor ladder passing (barely) while staggered same-tenor fails is the opposite of what
  the σ√τ band math predicted for a *mature* market (a long-dated strike should go stale as spot
  drifts over hours). In this short test, the 1h market hadn't had time to drift far from its
  strike yet — its wide band was still fully "fresh." A real multi-hour collection is needed to
  see whether the ladder's availability decays as the theory predicts, or holds up better than
  expected.
- Measurement 1 (gamma concentration) reading ~1.0 (gross≈net, i.e. little netting happening at
  these specific ticks) versus the earlier same-tenor-only run's 2.7-2.8 is a genuinely different,
  not-yet-understood shift worth re-checking once a real (unseeded) sample exists — plausibly just
  small-sample noise given n=61, but flagging rather than waving it away.

## What a real Phase 0 run needs

1. Leave the `market-generator` loops (5m/15m/1h, or add a longer one) running for hours/days
   under real trading activity, not hand-seeded trades.
2. Re-run `scripts/phase0-analysis.ts` against that organic data.
3. Specifically re-check measurement [2]'s ladder result once markets have had real wall-clock
   time to drift — this run was too short to distinguish "the ladder genuinely works" from
   "the ladder hasn't had time to fail yet."
