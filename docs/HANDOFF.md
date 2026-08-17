# Hedging — findings and handoff

**Status:** the delta-hedging sidecar is built, tested (51/51) and QA-hardened,
running read-only in dry-run. It has **not** run against live inventory with a
real execution venue. Everything below is what we learned and what I'd do next.

**Scope of the work:** can the directional risk the house takes on 5-minute BTC
binaries be neutralised on perps, and does the hedge cost less than the risk it
removes?

---

## 1. The headline result

**Delta hedging works. Gamma hedging with perps is impossible.** Both are settled
questions now, and the second one is the more important finding because it
redirects effort.

| | Unhedged | Delta | Delta + sentiment tilt |
|---|---:|---:|---:|
| P&L dispersion (σ) | $200 | $135 | **$126** |
| Worst-case window | **−$115** | +$85 | **+$109** |
| Dispersion removed | — | 33% | **37%** |

The book is **short gamma** — it loses on large moves in either direction — so a
single price path tells you nothing. These come from replaying the same order
flow across a range of BTC outcomes (−3%…+3% terminal, real intraday paths) and
measuring the spread of final P&L. Averaged over 11 real windows.

The residual after hedging is **adverse selection**, which no hedge removes. Only
the spread pays for that.

## 2. A perp cannot hedge terminal gamma — proven, not assumed

A perp is linear: Γ ≡ 0 by definition. A digital's value near expiry is a *step*,
its delta diverging as `φ(d)/(Sσ√τ)`. No linear instrument replicates a
discontinuity.

We tested it rather than asserting it. In an A/B, the worst-case window went
**−$94.5 → −$94.5** — a difference of exactly **0.0**, with hedging cost ≈
hedging benefit.

**Consequence:** stop trying to solve pin risk with the perp hedge. It is handled
where it can be — in **quoting** (pin-risk spread widening, per-tenor expiry
lockout) — and the hedger's correct behaviour near expiry is to *stand down*, not
to chase a delta it cannot fill.

## 3. Cross-market hedging: NO-GO on current data

Could other open markets absorb each other's gamma? We built a feasibility gate
with **pre-registered kill criteria**, caught a real unit-mismatch bug inside it,
and got an honest **NO-GO** on the sample collected.

Caveat worth respecting: the sample is small and was gathered over limited
wall-clock time. The result is "no evidence it works", not "proven impossible".
Re-running it under sustained organic flow is cheap and would settle it.

## 4. The most expensive bug: hedging the wrong curve

The service originally sized hedges with the **Black-Scholes** digital delta
while the exchange had already moved to quoting off an **empirically-calibrated**
curve. Hedging a sensitivity the book does not have is a pure fee generator.

Production measurement over live quotes: **1.6–2.2× over-hedging, 3.15× at the
money.**

Differentiating both curves directly (`core/digital.ts` vs `core/empirical.ts`)
across a σ sweep shows the structure of the error:

- **Independent of τ** — identical at τ = 60/150/300s. Both ATM slopes scale as
  `1/√τ`; only the constant differs.
- **Strongly dependent on σ** — ~2× over-hedge at the realised σ we saw (4e-5/s),
  exceeding **11×** in calm markets.
- **It inverts.** Above ~7e-5/s BS *under*-hedges.

So this was never a fixable constant — it is a regime-dependent error, which is
why the fix is to differentiate the curve you actually quote on rather than apply
a correction factor. `deltaCurve: 'empirical'` is now the default; `'bs'` remains
only as a rollback path.

**The general lesson:** the hedge must be differentiated from the *quoting* curve.
If pricing changes again, the hedge sizing changes with it — they are one
decision, not two.

## 5. Other defects found and fixed (all now covered by tests)

| Defect | Impact | Fix |
|---|---|---|
| `KEYS` scan of the whole Redis keyspace each poll | O(N) and **blocking** — on shared production Redis this stalls every service each poll | read the active-markets set; `keys` deliberately removed from the `RedisLike` interface so it cannot regress |
| Contract inventory reported under delta's name | Hedge Desk showed a **$66.8M "skew"** on ~$1,000 of real flow | `netContracts` and `delta` split into separate fields with distinct units |
| Delta diverging as τ→0 | demanded ~60 BTC of hedge on a book needing 3.5 — unfillable, and pure fee burn | `minTauSec` floor + `expiryLockoutSec`; deliberately under-report near expiry |
| Malformed Redis values | one bad key produced a NaN aggregate, silently disabling **all** hedging | `safeNum()` guards — a bad key skips one market, never the book |

**51 tests passing**: sign conventions, netting across markets, gate behaviour,
boundary conditions at expiry, fee/taper logic, and a 10k-market scale check that
asserts no `KEYS` usage.

## 6. Economics — why the gates exist

Hedging is not free, and in calm markets it **costs more than it saves**. Fees and
spread on each round trip exceed the risk removed when nothing moves.

Hence two gates, both of which must open before an order is placed: realised vol
must breach a threshold **and** exposure must clear an inventory floor. In a
representative replay the hedger is armed roughly **a third** of ticks; the rest
of the time `idleReason` names which gate is holding it back. Standing down is a
feature.

Related, from the simulator: the market maker pays an LMSR liquidity subsidy of
`b·ln2` per resolved market (~$76 at b=110). The vig has to out-earn that before
hedging economics matter at all. With the gamma-wall fix and a risk-tiered hedge
dial, a 5-minute market reaches **$77.9 mean net per window, 97% of windows
break-even** (64-window A/B, worst −$43).

---

## 7. What is NOT established

Stated plainly, because these decide whether any of the above survives contact
with production:

- **No live run.** The service has never hedged real inventory against a real
  execution venue. Dry-run only.
- **Simulated fills are too kind** — fills at mark, no slippage, latency or market
  impact. Simulation therefore **overstates** effectiveness. Only a demo-venue A/B
  measures the real thing.
- **A standalone 5-minute binary is the hardest case.** Real value should come
  from hedging the *aggregate across tenors*, which has not been measured.
- **Cross-market NO-GO is under-powered** (see §3).
- **Funding, basis and latency** are unmodelled: stochastic funding, settlement
  index ≠ perp mark, and hedging on stale prices.

## 8. Recommended next steps, in order

1. **Run the demo-venue A/B.** Alternating hedged/unhedged 5-minute windows with
   real fills, fees and funding. This is the only test that settles effectiveness;
   everything else is simulation. The window ledger already emits per-window CSV
   for exactly this.
2. **Re-run cross-market Phase 0 under sustained organic flow.** The gate and kill
   criteria already exist; it needs wall-clock time, not new code.
3. **Options overlay for terminal gamma** — the theoretically correct instrument.
   A digital replicates as a tight bull call spread
   `[call(K−ε) − call(K+ε)] / 2ε`; a short digital is hedged with a **long** call
   spread, matching both terminal payoff and near-strike convexity. Blocker:
   shortest listed BTC options (Deribit 0DTE) are **daily** — nothing matches a
   5-minute window. Next concrete step is a call-spread replication model against
   data we already record, **not** new infrastructure.
4. **Keep hedge sizing tied to the quoting curve.** If pricing changes, change
   both together (§4).

## Where things are

| | |
|---|---|
| Service | `gb-crypto-hedging-service` — TypeScript, Fastify, read-only, mainnet hard-blocked |
| Control plane | `GET /health`, `GET /state` on :8790 |
| Research simulator | where the dispersion and break-even numbers were derived |
| Notes | `docs/notes/` — engineering log, cross-market Phase 0, options overlay |
| Live demo | a replay dashboard driving the real inventory → gate → hedger path |

**Safety properties worth preserving:** never writes to any exchange datastore;
mainnet hosts throw at construction; `dry-run` is the default venue; the hedger
boots disabled and flattens any inherited position on restart.
