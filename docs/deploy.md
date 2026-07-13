# Deploy

## Image
Runs under `tsx` (no separate build). Multi-arch `node:22-slim`, non-root, with a `/health`
HEALTHCHECK.
```
docker build -t gb-crypto-hedging-service:latest .
docker run --rm -p 8790:8790 --env-file .env gb-crypto-hedging-service:latest
```
Or compose (points at a host Redis by default):
```
docker compose up --build
```

## Configuration & secrets
- All config is env (see `.env.example`). Secrets (`BINANCE_API_KEY/SECRET`) are provided at
  **runtime** via `--env-file` / orchestrator secret store — never baked into the image
  (`.dockerignore` excludes `.env`).
- Keys must be **futures-trade scope only** (no withdrawal). Mainnet hosts are hard-blocked.
- Rotate keys via the secret store + restart; `FLATTEN_ON_SHUTDOWN` decides whether the
  position is closed or held across the restart.

## Wiring to the stack
- `PREDICTOR_REDIS_HOST/PORT` → the Redis that holds `MMP_LMSR_QUANTITY_*` + `CRYPTO_SPOT_*`.
  - Local (gb-crypto-local): `host.docker.internal:6379` (compose default) or the stack network.
  - GameBull QA: the predictor Redis endpoint (read-only creds).
- `EXECUTION_VENUE=binance-demo` + demo keys to place real testnet perps; `dry-run` to observe.

## Health & readiness
- `GET /health` → `{ ok }` once the loop has ticked and has no fatal error. Used by the
  Docker HEALTHCHECK and k8s liveness/readiness probes.

## Observability
- `GET /metrics` — Prometheus. Scrape with `job="hedging-service"`.
- Alert rules: `ops/alerts.yml` (down, hedger error, loop stalled, position over cap, stale
  spot, armed-but-no-inventory).
- `GET /ledger` / `GET /report` — per-window hedge accounting; CSV at `data/ledger.csv`
  (mount a volume to persist).

## Shutdown policy
- `SIGTERM`/`SIGINT`: stop loop, then **hold** the position by default (a brief restart
  shouldn't churn the hedge). Set `FLATTEN_ON_SHUTDOWN=true` where an unwatched position is the
  bigger risk.

## Kill-switch
- `POST /kill` flattens to zero + disables. Wire to on-call / a dashboard button.

## Staging checklist
1. Deploy with `EXECUTION_VENUE=dry-run`, `INVENTORY_SOURCE=gamebull` pointed at QA Redis.
2. Confirm `/state` shows real `aggregateDelta` from QA inventory; `/metrics` scraping.
3. Add demo keys, `EXECUTION_VENUE=binance-demo`, `HEDGE_ENABLED=false`; confirm observe-only.
4. Enable via `POST /config {"enabled":true}`; watch `/ledger` + position on the testnet.
5. Load `ops/alerts.yml`; test `POST /kill`.

## Platform dependency (the one ask)
GameBull must publish `MMP_MARKET_META_{marketId}` (strike/expiry/underlying, feedId 3) for
crypto markets — see `docs/inventory-contract.md`. Everything else is read from keys the MMP
already maintains.
