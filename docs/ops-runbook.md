# Ops runbook

## Control plane
| Endpoint | Phase | Purpose |
|---|---|---|
| `GET /health` | 0 | liveness/readiness (200 = up, deps reachable) |
| `GET /state` | 0 | spot, realized vol, inventory (δ, notional, markets), gate, hedger, venue |
| `GET /metrics` | 3 | Prometheus metrics |
| `POST /config` | 3 | runtime gate tuning (no redeploy) |
| `POST /kill` | 3 | flatten position + disable hedge |

## Start / stop
```
npm run dev            # dev (tsx watch)
npm start              # run once
```
Set `INVENTORY_SOURCE=empty` to boot with no Redis dependency (idle loop, hedges nothing).

## Reading /state
- `inventory.aggregateDelta` — net BTC-equivalent exposure to hedge. 0 ⇒ nothing to do.
- `gate.armed` — hedging active this tick. If false, `gate.idleReason` says why
  (`disabled` | `idle-vol` | `idle-inv`).
- `gate.effectiveGate` — the current inventory threshold (adaptive: percentile of recent notional).
- `hedger.livePosition` / `hedgePnl` / `feesPaid` / `lastError`.

## Common situations
- **Gate never arms:** `notionalUsdt` below `effectiveGate`. Either flow is calm (correct) or the
  gate is too high — lower `HEDGE_NOTIONAL_USDT` or the percentile, or check inventory is flowing.
- **`lastError` set on hedger:** venue/API issue. Dry-run never errors; on `binance-demo` check keys
  and the demo endpoint.
- **Non-zero position but hedge OFF:** startup reconcile should flatten orphans; if it persists,
  hit `POST /kill` (Phase 3) or flatten manually on the venue.

## Kill-switch (Phase 3)
`POST /kill` closes the position (reduce-only to zero) and sets `enabled=false`. Use on any
anomaly. It is idempotent.

## Alerts (Phase 5, planned)
- hedger `lastError` non-null for > N ticks
- `/health` failing (Redis/venue unreachable)
- position notional > configured cap
- spot feed stale > `FEED_STALE_SEC`
