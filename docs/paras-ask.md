# Crypto hedging — status & asks (for Paras)

## TL;DR
I built the crypto perp-hedging system end-to-end, validated its internals hard, and traced it
against your **real `feat/lmsr` code**. It's containerized and tested. To finish, I need one
inventory detail confirmed, three quick decisions, one small platform change, and read-only
access. Nothing touches real money or prod at any step.

---

## What I found in the repos
- **Production is a CLOB + house-MMP, not an AMM** — verified across all 54 repos.
- **No crypto markets exist yet, and the LMSR code isn't in prod.** The MMP/LMSR code lives only
  on `feat/lmsr` (and `QA`) — `PRE`/`main` don't have it. So this vertical is genuinely still to
  be shipped.
- **Market metadata has no strike/expiry/underlying** (risk managed via `maxLoss` caps today) — a
  perp hedge needs those (platform ask B).

## What's done
- **`gb-crypto-hedging-service`** — standalone, read-only perp-hedging sidecar (TS + Fastify).
  Reads the house's LMSR inventory from Redis → aggregate BTC settlement-value delta → neutralizes
  on a **demo/paper** perp. **Never writes your stores or touches the order path.** Mainnet
  hard-blocked; secrets only in env. Containerized with health checks, metrics, and a kill-switch.
- **Traced against your real `feat/lmsr` `lmsrHelper`**: confirmed `MMP_LMSR_QUANTITY_YES/NO` are
  the LMSR pricing state, so my hedge reads the right signal and the **direction is correct**.
- **Hardened**: fixed three scale bugs before they could bite —
  (1) a Redis `KEYS` scan that would have blocked your shared Redis every poll (now reads the
  active-markets set); (2) an unpaginated DynamoDB Scan that would silently under-hedge past a few
  thousand bids; (3) a NaN/Infinity delta from a bad feed. Plus a 30-test adversarial suite.
- *(FYI, honest:* your own Jest suites are stale — `feat/lmsr` matcher is 78 failed / 109 passed —
  because CI runs SonarQube only, never the tests. Not a prod issue, but they aren't a safety net,
  so I wrote our own.)

---

## What I need from you

### 1. Confirm FIRST — LMSR inventory scaling (the source is already confirmed)
`MMP_LMSR_QUANTITY_YES/NO_{marketId}` are the right keys and `(qYes−qNo)·dp/dS` gives the correct
hedge **direction**. Three things affect hedge **size** — please confirm:
- **Units:** `q` is incremented by `bidCount × bidAmount` (notional cents; `b = volatility = 500`
  is calibrated to that). Should the hedge use `q` raw, or convert to share-count exposure?
- **Cumulative vs net:** nothing decrements these keys in any `feat/lmsr` repo. Is there a
  sell/settlement path that should, or are 5-min markets effectively buy-only (cumulative ≈ net)?
- **Seed:** `startOption1Q/startOption2Q` pre-loads `q` (synthetic liquidity, not real risk) — I
  plan to subtract it before hedging. Correct?

### 2. Quick decisions
- **Approach:** build the crypto vertical on the existing **MMP** + this hedge sidecar, not a new
  AMM. Confirm?
- **Instrument:** perps hedge the continuous delta but **can't** cover the digital's terminal/pin
  risk at expiry (proven). OK to ship perp-only first, options overlay later?
- **First deploy:** read-only *observe* mode in QA (no orders) → then demo-perp.

### 3. One platform change
- **Publish `MMP_MARKET_META_{marketId}`** for `feedId=3` markets — a small JSON blob
  `{ underlyingSymbol, strike, expiryTs, feedId }` in predictor Redis. The only thing the hedger
  needs that the MMP doesn't already write.
- **Confirm `predictor_active_markets` is the authoritative live-market index in prod** (my
  scalable read path iterates it; if liveness is tracked differently, point me at the right index).

### 4. Access (read-only)
- **Read-only QA Redis** (`qa-redis.…ap-south-1.cache.amazonaws.com`) — it's VPC-internal, so the
  service runs **inside the VPC**, or via a bastion / read-replica (your call on the safest path).
- **A Binance demo/testnet key** (futures-trade scope, no withdrawal) — or confirm I use my own.
- **PR sign-off** when ready: the sidecar needs zero changes to your repos; the only PRs are the
  crypto market pieces + the `MMP_MARKET_META` publish.

---

## Suggested path
Observe-only in QA (read real inventory, place nothing) → validate the delta against real flow →
demo-perp with the kill-switch → costed A/B (join with your settlement P&L) → review.
