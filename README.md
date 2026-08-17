# gb-crypto-hedging-service

A **read-only sidecar** that neutralises the directional BTC exposure GameBull's
house accumulates as users trade its crypto binary markets. Reads house inventory
from Redis, computes the aggregate settlement-value delta, and holds an offsetting
perpetual-futures position so a BTC move does not move the book's expected
settlement.

**Never writes to any GameBull data store.** Mainnet is hard-blocked at
construction. `DRY_RUN` is the default.

---

## The one thing to understand first

**A perpetual future cannot hedge a binary's terminal gamma. This is a
mathematical fact, not a limitation of this implementation.**

A perp is linear — Γ ≡ 0 by definition. A digital's value near expiry is a *step*,
with delta diverging as `φ(d)/(Sσ√τ)`. No linear instrument can replicate a
discontinuity. Confirmed empirically in an A/B: worst-case window went from
**−$94.5 → −$94.5**, a delta of exactly **0.0**, with hedging cost ≈ benefit.

So this service does the job a perp *can* do — hedge **delta** — and does it well:
**33–37% of P&L dispersion removed**, worst-case window **−$115 → +$85/+$109**.
The residual is adverse selection, which is unhedgeable by anything; only the
spread pays for it.

Terminal gamma is addressed elsewhere: in **quoting** (pin-risk spread widening,
expiry lockout — see `gb-crypto-local`) and, prospectively, an **options overlay**
(`docs/` and the parent architecture PDF §9.3). Cross-market hedging was tested as
an alternative and came back **NO-GO** (`docs/phase0-results.md`).

---

## Quick start

```bash
npm install
npm start                 # :8790, DRY_RUN, no keys needed — boots observe-only
curl localhost:8790/health
curl localhost:8790/state | jq
```

```bash
npm run selftest          # inventory -> gate -> hedger -> dry-run venue, end to end
npm run typecheck
npm run qa                # typecheck + 25 node:test tests + selftest
```

Requires the `gb-crypto-local` stack running (for Redis inventory) — see that repo.

---

## How it works

```
Redis  MMP_LMSR_QUANTITY_{YES,NO}_{mkt}     (written by gb-crypto-local's inventory-mirror)
       MMP_MARKET_META_{mkt}  {strike, expiryTs}
         │  poll every 2s
         ▼
inventory/gamebull.ts     δ_i = (qYes − qNo)·dp/dS      Γ_i = (qYes − qNo)·d²p/dS²
         │                aggregateDelta = Σ δ_i
         │                netContractsYes = Σ(qYes − qNo)   ← inventory skew, in CONTRACTS
         ▼
core/gate.ts              vol gate AND inventory gate → armed?
         ▼
core/hedger.ts            deadband, clamp to MAX notional, reduce-only
         ▼
venue/{dry-run,binance-demo}.ts   ← ExecutionVenue interface
         ▼
core/ledger.ts            per-window CSV: P&L, fees, fills, slippage, exposure
```

Spot comes from this service's **own** Binance WebSocket feed by default
(`SPOT_SOURCE=ws`), *not* GameBull's Redis key — see `docs/architecture.md` for why.

### dp/dS comes from the curve the exchange QUOTES on

`DELTA_CURVE=empirical` (default) differentiates `empiricalProbYes` — the curve
`gb-crypto-local` actually quotes on. It used to use the Black-Scholes `dp/dS`
from `core/digital.ts`, which was measurably wrong: against 78 live spot moves,
observed quote sensitivity was **1.6–2.2×** below what BS claimed (**3.15×** at
the money), so the hedge was oversized. Near-expiry and out-of-the-money it flips
— BS *under*-hedged by 2.6× — so this is a correctness fix, not a size reduction.

Because the empirical curve is piecewise-linear, `core/empirical.ts` takes a
**numerical** derivative over a finite bandwidth. Its exact derivative is a step
function that is zero in the flat segment at the money, which would put the hedge
at zero exactly where risk peaks. Rollback: `DELTA_CURVE=bs`.

**`EMPIRICAL_BREAKPOINTS` is duplicated** from `gb-crypto-local/drivers/lib/pricing.mjs`.
If those drift apart the hedge silently reverts to a curve we no longer quote —
`test/empirical.test.ts` pins them.

### Skew vs delta — two different quantities

`netContractsYes = Σ(qYes − qNo)` is **inventory skew**: which side the book leans,
in contracts. `aggregateDelta` is what that lean is **worth** per $1 of BTC.
Reporting the second under the first's name is what made the Hedge Desk display
$66.8M of "skew" on ~$1,000 of user flow. `/state` exposes both, plus `deltaCurve`
so no number's provenance is ever ambiguous again.

### The sign mapping — the silent-failure detail

```
qYes = houseNo,  qNo = houseYes
```

so that `(qYes − qNo)·dp/dS` **offsets** house exposure rather than amplifying it.
Getting this backwards **would not fail loudly** — it would silently **double** the
risk while appearing to hedge. It is verified end-to-end against live order flow,
not reasoned about on paper: *user buys NO → house long YES → delta < 0 → SHORT hedge.*

---

## Safety

| Control | Behaviour |
|---|---|
| Read-only | Reads Redis inventory; never writes to a GameBull store |
| Mainnet block | Service **refuses to start** against a mainnet Binance host |
| `DRY_RUN` | Default **on** — computes and logs orders without sending |
| Enable gate | Explicit opt-in required to trade |
| Position cap | `MAX_NOTIONAL_USDT` clamp |
| `POST /kill` | Idempotent flatten-and-disable |
| Secrets | `.env` only, gitignored, never in the image |

---

## HTTP surface

| Endpoint | Purpose |
|---|---|
| `GET /health` | Liveness + tick counter |
| `GET /state` | Spot, inventory (per-market δ and Γ), gate, hedger, venue |
| `GET /metrics` | Prometheus gauges |
| `GET /ledger`, `GET /report` | Per-window hedge ledger |
| `POST /config` | Runtime reconfiguration, no redeploy |
| `POST /kill` | Flatten to 0 and disable |

---

## Docs

| Doc | Covers |
|---|---|
| `docs/architecture.md` | Data flow, components, **why spot is not read from Redis** |
| `docs/roadmap.md` | Build phases 0–5 (all done) + post-Phase-5 work |
| `docs/inventory-contract.md` | The Redis key contract and sign mapping |
| `docs/execution-venue.md` | The `ExecutionVenue` interface |
| `docs/qa-plan.md` | What the adversarial suite covers — **and what it does not** |
| `docs/phase0-results.md` | Cross-market gamma hedging: NO-GO, with caveats |
| `docs/cross-market-hedging-research-plan.md` | The full 5-phase research design |
| `docs/deploy.md` | Docker, secrets, staging checklist |
| `docs/security.md`, `docs/ops-runbook.md` | Controls and operations |
| `docs/paras-ask.md` | The single ask of the platform team |

---

## Status

All six build phases shipped; QA-hardened (3 real production risks found and fixed).
Remaining work is environment-specific, not code:

1. **Staging deploy** next to GameBull QA — needs QA Redis credentials and Binance
   demo keys in `.env`.
2. **The platform ask:** publish `MMP_MARKET_META_{marketId}` for feed-3 markets.
   Their market metadata carries no strike/expiry/underlying (risk is managed via
   max-loss caps), so a perp hedge cannot be sized without it. See `docs/paras-ask.md`.

### Known-open, tracked

* **The inventory contract needs real-data validation.** Three questions affect
  hedge **size**, not direction: whether `q` is share- or notional-scaled; whether
  the cumulative keys are ever decremented (no sell path was found on `feat/lmsr`);
  and whether seeded synthetic liquidity must be subtracted before hedging.
* **The hedge budget is undersized against real gamma** — ATM near expiry the
  worst-case implied notional is ~$16M against a $10k budget. A capital decision,
  not an engineering one.
* **The full hedged-vs-unhedged book A/B** needs this hedge ledger joined with the
  distribution engine's per-window settlement P&L — a separate analytics job, since
  this service only owns the hedge side.
