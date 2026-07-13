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

## Phase 3 — Control plane + kill-switch  ✅
- `GET /metrics` (Prometheus gauges), `POST /config` (runtime gate tuning + enable/disable),
  `POST /kill` (flatten to zero + disable, idempotent).
- **Verified:** metrics expose δ/position/gate live; /config retunes the gate without redeploy;
  /kill flattens the position to 0 and the loop holds it flat/disabled after.

## Phase 4 — Observability + ledger + dashboard  ✅
- `core/ledger.ts` — per-window (clock-aligned, `LEDGER_WINDOW_MS`, default 5min) hedge-side
  ledger: hedge P&L, fees, fills, slippage, exposure mean/max, armed frac, position close.
  CSV-persisted (`data/ledger.csv`), preloaded on boot. `GET /ledger` + `GET /report`.
- `gb-crypto-local` dashboard hedge panel now reads THIS service's `/state` (source of truth;
  falls back to inline estimate if the service is down).
- **Verified:** windows roll + persist; `/report` summarizes; dashboard shows the live service
  position/gate/δ/P&L.
- **Follow-up (analytics):** the full hedged-vs-unhedged BOOK A/B needs a join of this hedge
  ledger with the exchange's per-window settlement P&L (distribution engine) — a separate job,
  since the service only owns the hedge side.

## Phase 5 — Productionization  ✅ (deploy artifacts)
- `Dockerfile` (node:22-slim, non-root, `/health` HEALTHCHECK, tsx runtime) + `.dockerignore`
  + `docker-compose.yml` (points at stack Redis; secrets via `.env` at runtime, never in image).
- `FLATTEN_ON_SHUTDOWN` policy (hold vs close position across restarts).
- `ops/alerts.yml` — Prometheus rules (down, hedger error, loop stalled, position over cap,
  stale spot, armed-but-no-inventory).
- `docs/deploy.md` — build/run, secrets, health, staging checklist, the platform ask.
- **Verified:** image builds; container boots + `/health` green.
- **Remaining (env-specific, needs infra access):** actual staging deploy next to GameBull QA
  (QA Redis creds + demo keys), scrape wiring, and the platform `MMP_MARKET_META` publish.

## Out of scope (tracked elsewhere)
- Options overlay for terminal gamma — see amm-hedging `options-hedging-idea`.
- Any change to GameBull repos — gated on Paras approval (Stage 1).
