# gb-crypto-hedging-service

A standalone **read-only perp-hedging sidecar** for GameBull's crypto (feed-3) LMSR
markets. It reads the house's net inventory from predictor Redis, computes the aggregate
settlement-value delta, and neutralizes it on a **demo/paper** perp venue. It never
touches GameBull's hot path, DB, or order flow.

This service extracts and productionizes the hedging brain proven in `~/Desktop/amm-hedging`
(the sim/research repo). amm-hedging stays as the backtest/A-B reference; **this** is the
deployable runtime.

## Golden rules
1. **Read-only against GameBull.** We only READ Redis keys (`MMP_LMSR_QUANTITY_*`,
   `MMP_MARKET_META_*`, spot). We never write their stores or call their write paths.
2. **Demo/paper only.** Mainnet Binance hosts are hard-blocked at config load
   (`src/config.ts`). The service refuses to start if pointed at a real-money venue.
3. **Secrets only in `.env`** (gitignored). Never commit keys. `.env.example` documents
   the surface.
4. **Every external edge is an interface.** `InventorySource` and `ExecutionVenue` are
   abstractions so demo→prod is a swap, not a rewrite.

## Architecture (one line each)
- `src/config.ts` — env-only config + the mainnet hard-block.
- `src/core/digital.ts` — digital (binary) option fair value + `dp/dS` (the delta).
- `src/core/gate.ts` — vol gate + adaptive-inventory gate (the "when to hedge" logic).
- `src/core/hedger.ts` — position reconciliation, hedge P&L, reduce-only + deadband.
- `src/inventory/` — `InventorySource` interface + `GamebullInventorySource` (the prod adapter).
- `src/venue/` — `ExecutionVenue` interface + `dry-run` (Phase 0) / `binance-demo` (Phase 2).
- `src/loop.ts` — the control loop: poll inventory → gate → target δ → `venue.moveTo` → ledger.
- `src/http/server.ts` — Fastify control plane: `/health`, `/state`, (later `/metrics`, `/config`, `/kill`).
- `src/index.ts` — bootstrap: config → wire deps → start loop + HTTP.

## How the pieces connect
```
predictor Redis  ──▶ GamebullInventorySource ──▶ Gate ──▶ Hedger ──▶ ExecutionVenue (demo perp)
 (LMSR qty + meta)        (aggregate δ)          (armed?)  (reconcile)   (dry-run | binance-demo)
```

## Run
```
cp .env.example .env         # keys stay here, never committed
npm install
npm run dev                  # boots loop + control plane on $PORT
curl localhost:8790/state    # inventory, gate status, hedger state
```
Requires the local stack's Redis (from `~/Desktop/gb-crypto-local`) for real inventory;
with `INVENTORY_SOURCE=empty` it boots and reports an idle loop with no dependencies.

## Docs
- [docs/architecture.md](docs/architecture.md) — components, data flow, boundaries.
- [docs/roadmap.md](docs/roadmap.md) — the phased plan (0→5) and current status.
- [docs/inventory-contract.md](docs/inventory-contract.md) — the exact Redis keys/shapes read.
- [docs/execution-venue.md](docs/execution-venue.md) — the venue interface + demo→prod swap.
- [docs/security.md](docs/security.md) — mainnet block, secrets, read-only guarantees.
- [docs/ops-runbook.md](docs/ops-runbook.md) — control plane, kill-switch, alerts.
- [docs/deploy.md](docs/deploy.md) — Docker/compose, secrets, staging checklist, platform ask.
- [docs/qa-environment.md](docs/qa-environment.md) — test strategy: levels, environments, techniques, traceability.
- [docs/qa-plan.md](docs/qa-plan.md) — coverage + explicit list of what is NOT covered.
- [docs/paras-ask.md](docs/paras-ask.md) — status & asks for the platform lead.

## Relationship to the other repos
- `~/Desktop/amm-hedging` — source of the hedging logic + the A/B validation. Reference only.
- `~/Desktop/gb-crypto-local` — the local exchange (their real trading-api/matcher/distribution).
  It publishes the inventory this service reads (via the `inventory-mirror` driver).
- GameBull Bitbucket repos — the production target. **No changes pushed there** without Paras approval.
