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

## The delta, precisely
For one market: the house holds `qYes` YES and `qNo` NO shares of a binary that pays on
`S_T ≥ K`. Its expected settlement value moves with spot at rate `dp/dS` (the digital delta,
`core/digital.ts`). Net exposure `(qYes − qNo)·dp/dS` in BTC-equivalent units. Summed across
live feed-3 markets on the hedge symbol → `aggregateDelta`. The hedge holds `−aggregateDelta`
… i.e. the venue target is `aggregateDelta` (long if positive) so P&L offsets.

## What this does NOT hedge
Terminal gamma / pin risk at expiry — a perp cannot cover the digital's discontinuous payoff
as τ→0. That's a known limit (see amm-hedging's `options-hedging-idea`): options, not perps,
reach the tail. This service targets the continuous delta only.
