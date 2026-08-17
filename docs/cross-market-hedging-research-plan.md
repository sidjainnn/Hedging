# Cross-market hedging — research plan

Status: **proposal**. Nothing here is built. Week numbering anchors at week of 2026-08-03.

## 1. Thesis

The house runs many concurrent binary markets on one underlying (BTC). Today each market's
risk is neutralised by a single external instrument — a perp — which hedges **delta only**.
A perp is linear (`Γ ≡ 0`), so it structurally cannot hedge the terminal gamma of a digital,
whose peak gamma diverges as `O(1/τ)`. That is not a tuning problem; it is an instrument
mismatch, and it is the residual risk the AMM currently pays for with the pin-risk spread
widening + expiry lockout in `quoting.mjs` rather than hedging.

**The claim to test:** the exchange's *own* other markets are the only instruments available
that have digital-shaped gamma on the same underlying, and are therefore the only candidates
for hedging the risk the perp cannot.

### 1.1 What is *not* the opportunity (important)

Delta netting across markets is **already done**. `GamebullInventorySource` sums per-market
δ into `aggregateDelta`, and the hedger targets that net figure, not gross exposure. Offsetting
markets already cancel before a single perp order is sent. Any pitch claiming "net exposures
across markets to reduce hedge cost" is describing existing behaviour.

The unexploited axis is **gamma**, which is currently neither measured, netted, nor hedged.
This plan is about that axis specifically. Scoping it this way also makes it falsifiable.

## 2. Baseline — what exists today

| Capability | State |
|---|---|
| Per-market δ, aggregated | ✅ `inventory/gamebull.ts` → `AggregateInventory` |
| Delta hedge vs perp | ✅ `core/hedger.ts`, gated + deadbanded |
| Skew-offset effectiveness metric | ✅ `loop.ts` `skewOffsetPct` (added 2026-07-29) |
| Per-window hedge ledger | ✅ `core/ledger.ts` (CSV) |
| Per-market **Γ** | ❌ never computed |
| Per-market exposure **history** | ❌ `inventory-mirror` only `SET`s current state; nothing persisted |
| Portfolio-aware quoting | ❌ `quoting.mjs:28` skews off single-market `netSkew` |

The two ❌ data gaps gate everything downstream and are the first work items.

## 3. Two tracks

Cross-market hedging splits into two mechanisms with very different risk and cost profiles.
Conflating them is the main way this proposal could go wrong.

### Track A — passive: portfolio-aware quote skewing (recommended)

Do not *send* a hedge order into market B. Instead **skew market B's own quotes** so incoming
user flow arrives pre-shaped to offset market A's risk. The house is already the LP on B; it
can choose which side it wants filled.

Why this is the better mechanism:
- **Earns spread instead of paying it.** Active hedging crosses a spread on every rebalance.
  Passive skewing collects it.
- **Sidesteps the self-trading problem.** The house cannot meaningfully hedge by trading against
  its own quotes — that nets to zero. Risk only transfers when a *user* is the counterparty.
  Track A's entire mechanism is "attract the user flow you want," which is the only version of
  internal hedging that transfers real risk.
- **No liquidity circularity.** Track B consumes the depth the MM posted for users; Track A adds
  depth on the side it wants.
- It is a strict generalisation of code that already exists and is already tuned.

### Track B — active: execute a hedge in another market

Compute `N_B = −N_A · Γ_A/Γ_B` and trade it. Simpler to reason about, much worse economics
(pays spread, consumes own book depth, needs genuine third-party liquidity in B). Keep as a
fallback for when Track A's passive skew cannot rebalance fast enough — i.e. the last seconds
before expiry, which is exactly when gamma is worst. Do not lead with it.

## 4. Mathematical framework

### 4.1 Per-market Greeks (already derivable, not yet computed)

For a cash-or-nothing digital under BS with `d₂ = [ln(S/K) + (r − σ²/2)τ] / (σ√τ)`:

```
Δ = φ(d₂) / (S σ √τ)
Γ = − φ(d₂) · d₁ / (S² σ² τ),      d₁ = d₂ + σ√τ
```

`core/digital.ts` already returns delta as the `dpdS` field of `digitalProb()` (note: `inventory-contract.md`
refers to it loosely as `digitalDelta` — there is no such standalone export). Gamma is a ~5-line
addition to the same function's return, reusing the `normPdf`/`d₂` it already computes.

### 4.2 The usable-gamma band — why hedge availability is the gating question

`Γᵢ(S)` is a bump centred on `Kᵢ` of width `≈ σ√τᵢ`; outside it, gamma decays to ~0 and the
instrument has nothing to offer. At BTC ≈ $65k, σ ≈ 60% annualised:

| Tenor | σ√τ | band around strike |
|---|---|---|
| 5 m | 0.185% | ±$120 |
| 15 m | 0.32% | ±$208 |
| 60 m | 0.64% | ±$416 |
| 5 h | 1.43% | ±$930 |

Since BitBull sets an ATM strike at each market's open, two markets opened `Δt` apart have
strikes separated by roughly one `Δt`-move. For staggered *same-tenor* markets (opened minutes
apart) that separation is small relative to the band → gamma is available and the hedge ratio
is well-conditioned. For a *long-tenor* rung (the 15m/60m/5h ladder), the strike was set hours
ago and spot has had a full σ√τ to wander → the instrument may have **zero usable gamma exactly
when the near-dated market needs it**.

**Prediction to test in Phase 0:** availability is high for the single-hop staggered same-tenor
hedge and low for the long-tenor ladder. If that confirms, the ladder idea is dead on arrival
and we know it in week 2 rather than month 3.

### 4.3 Portfolio covariance in closed form (the Track A core)

All markets settle on the same Brownian path, so the covariance of two digital payoffs is
analytic. For expiries `τ₁ < τ₂`, the driving Brownian increments have
`ρ = Corr(W_τ₁, W_τ₂) = √(τ₁/τ₂)`, and

```
Σᵢⱼ = Cov(1{S_τᵢ ≥ Kᵢ}, 1{S_τⱼ ≥ Kⱼ}) = Φ₂(d₂⁽ⁱ⁾, d₂⁽ʲ⁾; ρᵢⱼ) − Φ(d₂⁽ⁱ⁾)·Φ(d₂⁽ʲ⁾)
```

with `Φ₂` the bivariate normal CDF. This gives a full, closed-form portfolio covariance matrix
over live markets — no estimation, no correlation-fitting, no rolling window.

Portfolio variance is `qᵀΣq`, so market *i*'s marginal risk contribution is `∂(qᵀΣq)/∂qᵢ = 2(Σq)ᵢ`.
The Track A change is then a one-line conceptual generalisation of `quoting.mjs:28`:

```
current:   r_i = pFair − f(q_i)              · γσ²τ̂      (own inventory only)
proposed:  r_i = pFair − f((Σq)_i / ‖·‖)     · γσ²τ̂      (portfolio risk contribution)
```

When markets are uncorrelated or the book is flat elsewhere, `(Σq)ᵢ → Σᵢᵢqᵢ` and this reduces
to today's behaviour — so the change is *strictly* a generalisation and can be shipped behind
a scalar blend `λ ∈ [0,1]` between old and new skew, with `λ=0` byte-identical to production.

This is multi-asset Avellaneda–Stoikov / Guéant-style portfolio market making, which is known
literature. The novel part is not the control law; it is that for digitals on a *shared*
underlying with nested expiries, `Σ` is exactly computable rather than estimated.

## 5. Phases

### Phase 0 — Feasibility study (week 1–2) · **decisive gate, no product code**

Purpose: answer "is there anything here at all" before building anything. Designed so a
negative result is cheap and arrives early.

0.1 **Close the data gap.** Add a per-market exposure recorder — `inv.markets[]` already carries
`{marketId, strike, expiryTs, qYes, qNo, delta}` in memory every tick and is discarded. Persist
it (extend `ledger.ts`, or a sibling CSV). Add `digitalGamma` and record per-market Γ and `q·Γ`.
Read-only, no behaviour change. ~1 day.

0.2 **Gamma concentration.** From the recorded series compute gross `Σᵢ|qᵢΓᵢ|` vs net `|Σᵢ qᵢΓᵢ|`.
Report the distribution of the ratio, not the mean. If net ≈ gross, markets move in lockstep and
there is nothing to net.

0.3 **Hedge availability (the key measurement).** At every tick where `|qᵢΓᵢ|` exceeds a
high-risk threshold, test whether a usable counter-instrument existed: some live market *j ≠ i*
with `|S − Kⱼ| < c·σ√τⱼ` and materially different τ. Report the **fraction of high-gamma moments
with an available hedge**, split by candidate mechanism (staggered same-tenor vs long-tenor ladder).

0.4 **Flow decorrelation.** Measure the correlation of user flow direction across concurrent
markets. Track A only works if flow is idiosyncratic enough to be steerable; if every user hits
YES everywhere at once, quote skewing cannot rebalance and only external hedging can.

**Kill criteria (agree these before starting):**
- 0.2 gross/net ratio < **1.15** at p50 → negligible netting structure → stop.
- 0.3 availability < **30%** for *both* mechanisms → no instrument exists when needed → stop.
- 0.4 cross-market flow correlation > **0.8** → Track A cannot steer flow → drop Track A, reassess
  Track B on its worse economics alone.

### Phase 1 — Offline backtest harness (week 3–5)

Reuse the Monte Carlo + scoring pattern from `finetune/calibration_report.py` (already proven).
Reuse the Binance 1s/1m history already pulled for the Kronos work.

Strategies to compare on identical paths:
1. Perp-only (production baseline)
2. Perp + portfolio-aware skew (Track A, sweep `λ`)
3. Perp + active cross-hedge (Track B)
4. Perp + both

Metrics: realised terminal P&L **variance** (the actual objective — not mean P&L, which is
noise-dominated at this sample size), total cost (fees + slippage + spread paid), residual
`|qΓ|` at expiry, and hedge turnover.

Methodology guards, learned from the Kronos runs:
- Fills modelled conservatively (cross the spread, never assume mid).
- Report per-regime, not pooled — a single calm window will flatter everything.
- Pre-register the metric and the sample before running. The Kronos evaluation is the cautionary
  case: an off-by-one in the settlement horizon silently scored the wrong bar, and the *large*
  sample re-run reversed the apparent early result.

**Gate:** Track A must reduce terminal P&L variance by a pre-registered margin **net of costs**
against baseline, or it does not proceed.

### Phase 2 — Shadow mode (week 6–8)

Run the portfolio skew computation live, log the quotes it *would* have posted, execute nothing.
Same read-only-sidecar discipline the hedging service already follows. Compare shadow decisions
against actual production quoting; confirm the offline model's predictions hold on live flow.
Add `hedging_portfolio_gamma`, `hedging_hedge_availability` to `/metrics`.

**Gate:** shadow predictions track live outcomes within tolerance. Any divergence between the
backtest and live behaviour must be explained before proceeding — not averaged away.

### Phase 3 — Limited live (week 9–12)

Enable Track A with `λ` ramped from 0, hard exposure caps, and a kill switch reusing the existing
`POST /kill` pattern. A/B by alternating windows so both arms see comparable regimes. Track B, if
it survived Phase 1, comes only after Track A is stable.

### Phase 4 — Product dependencies (not scheduled)

The precise version of this needs multi-strike listings per expiry (a strike strip, or Kalshi-style
bucket markets). That converts the approximate cross-market hedge into an exact same-tenor vertical
spread and makes the implied density directly observable. Large product change; explicitly out of
scope here and gated on Phases 0–2 justifying it.

## 6. Risks

**Modelling**
- BS digital Greeks assume lognormal diffusion; crypto jumps. Everything here hedges the diffusive
  component only. Jump residual needs a capital reserve, not a hedge — size it separately.
- `Γ` depends on σ; a bad vol estimate mis-sizes every ratio. The existing `MIN_SIGMA_PER_SEC`
  cold-start floor is a precedent for how badly this can bite.
- Binary gamma is sign-flipping across its own strike. A hedge sized on `|Γ|` alone can *add*
  risk. Ratios must be signed and continuously recomputed.

**Execution**
- Track B pays spread and consumes own-book depth (see §3).
- Frequent rebalancing near expiry can churn fees faster than it removes risk — the same
  trade-off the existing deadband taper already manages for the perp.

**Operational**
- This adds cross-market coupling to a quoting path that currently reasons about one market at
  a time. This session alone surfaced a requote in-flight guard that allowed two `mmp-pricing`
  processes to race the same book, and a fill-detection race that misreported resting orders as
  filled. Coupled cross-market state is strictly more surface area. Ship behind `λ` and keep
  `λ=0` provably identical to today.

**Research-methodology**
- Short/calm evaluation windows. The 1-second Kronos run's ~10h of non-diverse history is the
  in-house example of this trap.
- Negative results must be reportable. The Kronos work's value was an honest negative; this plan
  is structured (Phase 0 kill criteria) so the same outcome is cheap here.

## 7. Deliverables

| Phase | Deliverable |
|---|---|
| 0 | Per-market exposure/Γ recorder; feasibility memo with the four measurements + go/no-go |
| 1 | Backtest harness + strategy comparison report |
| 2 | Shadow-mode service + live-vs-model validation |
| 3 | `λ`-gated portfolio skew in production, A/B results |

## 8. Open questions

1. Does BitBull's market generator stagger opens enough to create the τ-spread Track A/B needs,
   or do markets open on the same boundary with near-identical strikes and near-identical τ?
2. What is real user flow correlation across concurrent markets? Nothing today measures it.
3. Is per-market `q` even recoverable historically from `bb_pending_bids`, or does Phase 0 have
   to start collecting forward from day 1? (Affects Phase 0 duration materially.)
4. GameBull-side: does any of this require changes in their repos, which are gated on approval?
   Track A touches `quoting.mjs`, which is ours — confirm that boundary holds.

## 9. References

- Avellaneda & Stoikov (2008), *High-frequency trading in a limit order book* — the reservation
  price/spread control already used in `quoting.mjs`.
- Guéant, Lehalle & Fernandez-Tapia — inventory risk & the multi-asset generalisation Track A follows.
- Breeden & Litzenberger (1978) — digital as `−∂C/∂K`; the basis for the Phase 4 strike-strip case.
- In-repo: `docs/roadmap.md` (service phases), `docs/inventory-contract.md` (Redis surface),
  `drivers/lib/quoting.mjs` (insertion point for Track A).
