> Engineering notes carried over from working sessions. Findings, root
> causes and decisions recorded as they were made — kept because the
> reasoning behind a fix is usually harder to recover than the fix.

Distinct from [[hedging-service]]'s own "Phase 0-5" (the sidecar's build
phases — scaffold/inventory/venue/control-plane/ledger/docker, all shipped).
**This is a separate research question**, also run inside
`~/gb-crypto-hedging-service`: since a linear perp structurally cannot hedge a
digital's terminal gamma (proven earlier — A/B showed literally zero
improvement, `$-94.5 → $-94.5`, see [[options-hedging-idea]]), could the
exchange's *other concurrently-open markets* on the same underlying serve as
a gamma hedge for each other? Full plan in
`gb-crypto-hedging-service/docs/cross-market-hedging-research-plan.md`; this
memory covers the concrete Phase 0 feasibility gate that was actually built
and run.

**Why Phase 0 was needed first:** two data gaps blocked every measurement —
gamma was never computed anywhere in the service (only delta via `dpdS`), and
per-market exposure history was never persisted (Redis only held current
state). Both closed additively, no existing behavior changed:

1. **`core/digital.ts`** — added closed-form digital gamma
   `d2pdS2 = φ(d)·d1 / (S²σ²τ)` alongside the existing `dpdS`, with tests for
   the τ→0 blowup and the sign flip across the strike (the property that makes
   naive `|Γ|`-only hedge ratios unsafe).
2. **`inventory/gamebull.ts`** — `poll()` now computes `gamma = (qYes−qNo)·d2pdS2`
   per market alongside the existing `delta`, added to `HedgeableMarket`.
3. **`core/exposure-recorder.ts`** — new CSV recorder (same pattern as
   `ServiceLedger`), one row per `(tick, live market)`:
   `ts, marketId, strike, expiryTs, tauSec, spot, qYes, qNo, delta, gamma`.
   Gated behind `RECORD_EXPOSURE=true`, off by default.
4. **`scripts/phase0-analysis.ts`** — offline analysis over the recorded CSV,
   three pre-registered measurements with kill thresholds (not modeling —
   direct queries):
   - Gamma concentration: gross `Σ|qΓ|` vs net `|Σ qΓ|` per tick, p50/p90.
     Kill if p50 < 1.15.
   - Hedge availability: at high-γ ticks (top decile), does another live
     market have spot within its usable-gamma band (`c·σ√τ`, c=2) and
     materially different τ? Split staggered-same-tenor vs long-tenor.
     Kill if <30% for either.
   - Flow decorrelation: correlation of `Δ(qYes−qNo)` direction across
     concurrent markets. Kill if >0.8.

**A real bug caught during the first run, not just a data-quality caveat:**
the first pass reported 0.0% hedge availability on BOTH legs, even at a tick
with clearly-live oppositely-signed inventory on a 5m and a 1h market
simultaneously — suspiciously clean, not trusted at face value. Root cause:
the usable-gamma band (`BAND_C·σ√τ`) is a **fractional** (log-moneyness)
width, but was being compared directly against a **dollar** distance
(`|spot−strike|`) without multiplying by spot to convert units — guaranteeing
`usable === false` on every real market regardless of true availability.
Fixed by multiplying the band by `other.spot` before comparing
(`scripts/phase0-analysis.ts`, "Measurement 2").

**Setup for the actual run:** parameterized `market-generator`'s hardcoded
5-minute `TENOR_MS` into `TENOR_MIN` (env), so 5m/15m/1h could run
concurrently (marketId/filterId now derive from the tenor tag instead of a
hardcoded `btc5m…` prefix). Verified `STRIKE_ROUND_USD=10` stays well under
10% of the usable-gamma band at every tenor. Seeded deliberately decorrelated
cross-tenor flow (YES on live 5m, NO on live 1h) via fresh logged-in test
users — raw unlogged-in userIds fail with "insufficient balance" since
`bb_users` rows only get a starting balance after `POST /api/login`.
687 rows recorded.

**Result, post-bug-fix (`npx tsx scripts/phase0-analysis.ts`):**

| Measurement | Result | Threshold | Verdict |
|---|---|---|---|
| Gamma concentration (gross/net) | p50=1.02, p90=3.49 (n=61 ticks) | kill if p50<1.15 | **FAIL** |
| Hedge availability — staggered same-tenor | 24.3% (n=70) | kill if <30% | **FAIL** |
| Hedge availability — long-tenor ladder | 30.0% | kill if <30% | PASS (borderline) |
| Flow decorrelation (median \|corr\|) | 0.023 (n=2 pairs) | kill if >0.8 | PASS |

**GO/NO-GO: NO-GO** — measurement 1 and the staggered leg of measurement 2 are
both kill conditions. Full writeup: `docs/phase0-results.md`.

**Read this honestly, not as final:** sample sizes (61 ticks, 70 moments, 2
market pairs from one short hand-seeded run) are far too small to trust these
numbers as a real research conclusion — this run's actual value was proving
the **pipeline** computes correctly post-fix, not settling the question. Two
specific things flagged as needing a real multi-hour/multi-day organic run to
resolve: (1) the long-tenor ladder barely passing is the OPPOSITE of what
theory predicts for a mature market (a long-dated strike should go stale as
spot drifts over hours) — in this short test the 1h market hadn't had time to
drift yet, so its band was still artificially "fresh"; (2) gamma concentration
reading ~1.0 (little netting) vs. an earlier same-tenor-only run's 2.7-2.8 is
an unexplained shift, plausibly small-sample noise (n=61) but not waved away.

**How to apply:** if asked "is cross-market hedging viable," the honest
current answer is **no-go on this pipeline-verification-grade data**, with an
explicit, cheap next step (leave the tenor ladder running for real hours/days,
re-run the same unmodified script) rather than a resolved yes/no. This is a
strong interview story precisely because of the caught unit-mismatch bug
(fractional vs. dollar band) — a wrong-looking-too-clean 0.0% result that got
investigated rather than accepted.
