# Roadmap

Phased path from a booting skeleton to a staging-deployable service. Status is kept current.

## Phase 0 — Scaffold + dry-run loop  ✅ (in progress)
- Repo, TS + Fastify, env config with **mainnet hard-block**.
- Core extracted from amm-hedging: `digital`, `gate`, `hedger` (venue-abstracted).
- `InventorySource` + `GamebullInventorySource`; `ExecutionVenue` + **dry-run** venue.
- `loop` + `/health` + `/state`. Boots with no keys; `curl /state` shows gate + inventory.
- **Done when:** service runs, polls inventory (empty ok), reports gate status, dry-run venue
  logs intended orders.

## Phase 1 — Inventory ingestion from the real stack  ✅
- `inventory-mirror` driver in `gb-crypto-local`: `bb_pending_bids` house matched → `MMP_LMSR_QUANTITY_*`
  (sign mapping `qYes=houseNo, qNo=houseYes` so the hedge OFFSETS, not doubles — see the driver header).
- `GamebullInventorySource` wired to the local predictor Redis; spot from `CRYPTO_SPOT_BTCUSDT`.
- Realized-vol from the spot stream, with `MIN_SIGMA_PER_SEC` floor (cold-start guard — the known gotcha, resolved).
- **Verified:** live house short-YES 95 → `aggregateDelta +0.31` → gate armed → hedger LONG 0.159 BTC
  (clamped to the $10k cap); expired markets skipped. Direction correct (short YES → LONG).

## Phase 2 — Binance demo execution venue  ✅
- `binance-demo` venue ported from amm-hedging's `binance.ts` (mark, position, filters, market
  order w/ fill-price lookup, leverage, multi-assets). Mainnet re-asserted at construction.
- Startup orphan-flatten; reduce-only + deadband inherited from the hedger.
- **Verified:** mainnet host REFUSES to start; observe-only boot with no keys (key-gated).
  Live testnet fills need demo `BINANCE_API_KEY`/`SECRET` in `.env` (user-provided) — code path
  is complete and key-gated.

## Phase 3 — Control plane + kill-switch
- `/metrics` (Prometheus), `POST /config` (runtime gate tuning), `POST /kill` (flatten + disable).
- Structured logging, graceful shutdown policy (flatten vs hold).
- **Done when:** ops can retune gates and kill the hedge without a redeploy.

## Phase 4 — Observability + A/B + dashboard
- Persist the `WindowLedger`; expose the A/B report as an endpoint/job.
- Point the `gb-crypto-local` dashboard hedge panel at this service's `/state`.
- **Done when:** hedged-vs-unhedged accounting is visible live and exportable.

## Phase 5 — Productionization
- Container hardening, secrets management, staging deploy next to GameBull QA.
- Platform ask (already known): publish `MMP_MARKET_META` for feed-3 markets.
- Runbook, alerts, on-call kill-switch.
- **Done when:** running in staging against QA inventory with alerting.

## Out of scope (tracked elsewhere)
- Options overlay for terminal gamma — see amm-hedging `options-hedging-idea`.
- Any change to GameBull repos — gated on Paras approval (Stage 1).
