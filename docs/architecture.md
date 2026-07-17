# Architecture

## Purpose
Neutralize the house's directional BTC exposure that accumulates as users trade GameBull's
crypto (feed-3) binary markets. The house (MMP) takes the other side of user flow; the net
of that inventory has a settlement-value delta w.r.t. BTC spot. This service holds an
offsetting perp position so a BTC move doesn't move the book's expected settlement.

## Data flow
```
┌─ GameBull side (read-only) ──────────────┐     ┌─ hedging service ─────────────────────┐
│ predictor Redis                          │     │                                       │
│   MMP_LMSR_QUANTITY_YES_{mkt}  ──────────┼────▶│ GamebullInventorySource.poll()        │
│   MMP_LMSR_QUANTITY_NO_{mkt}             │     │   for each feed-3 market on SYMBOL:   │
│   MMP_MARKET_META_{mkt} {strike,expiry}  │     │     δ_i = (qYes−qNo)·dp/dS            │
│   CRYPTO_SPOT_BTCUSDT  (spot)  ──────────┼────▶│   aggregateDelta = Σ δ_i             │
└──────────────────────────────────────────┘     │            │                          │
                                                  │            ▼                          │
                                                  │  Gate.update(vol, notional)           │
                                                  │   volGateOn && invGateOn → armed      │
                                                  │            │                          │
                                                  │            ▼                          │
                                                  │  target = armed ? aggregateDelta : 0  │
                                                  │  Hedger.reconcile(target, spot)       │
                                                  │            │                          │
                                                  │            ▼                          │
                                                  │  ExecutionVenue.marketOrder(...)  ────┼──▶ demo perp
                                                  └───────────────────────────────────────┘
```

## Components
| Module | Responsibility | Prod-swap boundary? |
|---|---|---|
| `config` | env config, mainnet hard-block | — |
| `core/digital` | binary fair value + `dp/dS` | — |
| `core/gate` | vol + adaptive-inventory gating, hysteresis | — |
| `core/hedger` | position reconcile, hedge P&L, reduce-only, deadband | — |
| `inventory/GamebullInventorySource` | read LMSR inventory → aggregate δ | **yes** (`InventorySource`) |
| `venue/*` | place/close the hedge position | **yes** (`ExecutionVenue`) |
| `loop` | orchestration tick | — |
| `http/server` | control plane | — |

## Why a service (not the amm-hedging server)
- Deployable alongside GameBull's microservices (its own container, config, health, metrics).
- A hard read-only boundary — no sim, no A/B venue, no research code in the runtime path.
- Interfaces at every external edge → demo→prod is swapping an implementation, not editing logic.

## The delta, precisely (and why the hedge is +δ)
For one market: users hold `qYes` YES / `qNo` NO shares of a binary paying on `S_T ≥ K`; the
house (market maker) is **short** those outstanding shares. The digital's fair value moves with
spot at rate `dp/dS` (`core/digital.ts`), so the house's value moves at
`d(house)/dS = −(qYes − qNo)·dp/dS` — i.e. if users are net-long YES (`qYes > qNo`), the house
**loses** when spot rises.

To offset, the hedge needs `d(hedge)/dS = +(qYes − qNo)·dp/dS`. A LONG perp of size `N` has
`d/dS = +N`, so `N = (qYes − qNo)·dp/dS`. Summed across live feed-3 markets → `aggregateDelta`,
and the venue target is **`+aggregateDelta`** (LONG when positive). A $1 spot rise then gains on
the perp exactly what the house loses on the book → net ≈ 0. (Confirmed live: users buy NO ⇒
house long YES ⇒ δ<0 ⇒ SHORT hedge.)

## What this does NOT hedge
Terminal gamma / pin risk at expiry — a perp cannot cover the digital's discontinuous payoff
as τ→0. That's a known limit (see amm-hedging's `options-hedging-idea`): options, not perps,
reach the tail. This service targets the continuous delta only.
