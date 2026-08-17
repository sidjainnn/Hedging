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

## Post-Phase-5 work (2026-07-29 to 07-31)

### QA hardening — 3 real production risks found  DONE
A deliberately adversarial suite (`npm run qa`) surfaced defects that would only
appear under load:
- **CRITICAL** — the inventory adapter used Redis `KEYS` on **every poll**, which
  blocks a shared production Redis. Now reads the maintained active-markets SET
  via `SMEMBERS`.
- **HIGH** — a DynamoDB `Scan` was not paginated; past the 1MB cap it would
  **silently under-hedge**. Now loops on `LastEvaluatedKey`.
- **MEDIUM** — NaN/Infinity propagation through the digital math on a zero or
  malformed spot. Guards + `safeNum` added.
`docs/qa-plan.md` records what the suite does **not** cover rather than claiming
full coverage.

> The pagination defect was later found **again in `gb-crypto-local`'s app layer**
> (`portfolio()`, `settle()`, `roundReset()`), where it made positions vanish and
> would have left winners unpaid. Fixed there too. Lesson: sweep a bug class across
> the whole codebase, not just the site where it was noticed.

### Digital gamma + exposure recorder  DONE
- `core/digital.ts` gained closed-form gamma `d2p/dS2 = -phi(d)*d1/(S^2 sigma^2 tau)`,
  unit-tested for the tau->0 blowup and the sign flip across the strike (the
  property that makes naive |Gamma|-only hedge ratios unsafe).
- `inventory/gamebull.ts` computes per-market `gamma` alongside `delta`.
- `core/exposure-recorder.ts` — CSV of `(tick, market, tau, spot, qYes, qNo, delta, gamma)`,
  behind `RECORD_EXPOSURE=true`, **off by default**.

### Cross-market gamma hedging — Phase 0 feasibility  NO-GO
**Naming warning:** this is a *separate research question* from the build phases
above, with its own unrelated "Phase 0". Do not conflate them.

Question: since a linear perp provably cannot hedge terminal gamma, can the
exchange's *other concurrently-open markets* hedge each other?
`scripts/phase0-analysis.ts` tests three pre-registered kill criteria. Result:
**2 of 3 failed** -> NO-GO. Full writeup and the honest sample-size caveats in
`docs/phase0-results.md`.

A real bug was caught by distrusting a too-clean result: the first run reported
0.0% availability on both legs because a **fractional** (log-moneyness) band was
being compared against a **dollar** distance. Fixed by converting units.

**Caveat:** 61 ticks / 2 market pairs from one hand-seeded run. The value of that
run was proving the pipeline computes correctly, not settling the question. A real
answer needs the tenor ladder running for hours/days under organic flow, then a
re-run of the *unmodified* script.

## Out of scope (tracked elsewhere)
- Options overlay for terminal gamma — see amm-hedging `options-hedging-idea`.
- Any change to GameBull repos — gated on Paras approval (Stage 1).
