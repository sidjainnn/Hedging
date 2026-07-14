# Crypto hedging — status & asks (for Paras)

## TL;DR
I built the crypto perp-hedging system end-to-end and validated it against your real
services locally. It's containerized and tested. To move to your QA/staging I need three
decisions confirmed, one small platform change, and read-only VPC access. Details below.

---

## What I found in the repos (context for the asks)
- **Production is a CLOB + house-MMP, not an AMM.** Verified across all 54 repos — liquidity
  is the MMP quoting off the SkillPoll feed and matching complementary bids. No AMM anywhere.
- **No crypto markets exist yet.** The engine supports non-sports (`feedId=3`), but there are
  no live crypto markets — this vertical has to be built. (This is, I assume, why the project
  came to me.)
- **Your market metadata has no strike/expiry/underlying.** Risk today is managed via
  `maxLoss` caps. A perp hedge needs those fields — that's the one platform ask below.

## What's done
- **`gb-crypto-hedging-service`** — a standalone, read-only perp-hedging sidecar (TS + Fastify).
  It reads the house's net LMSR inventory from Redis, computes the aggregate BTC settlement-value
  delta, and neutralizes it on a **demo/paper** perp venue. **It never writes your stores or
  touches the order path.** Mainnet venues are hard-blocked; secrets live only in env.
- **Proven end-to-end locally** against your *real, unmodified* trading-api, matching engine,
  and distribution engine (driven through their existing interfaces — no repo changes): market →
  house liquidity → match → settle → payout, with the hedge tracking house inventory live.
- **Containerized** (health-checked image, control plane: metrics, runtime config, kill-switch)
  and covered by an adversarial test suite.

## Production risks I found and fixed while hardening it
Flagging these because they're the kind of thing that only bites at your scale:
1. **A naive Redis `KEYS` scan** would have blocked your shared Redis on every poll — replaced
   with reading the active-markets set (non-blocking). *(See ask #2.)*
2. **An unpaginated DynamoDB Scan** would have silently under-hedged past ~a few thousand bids —
   fixed to paginate.
3. **A NaN/Infinity delta** from a bad feed/value could have mis-sized the hedge — guarded.

I also ran your existing Jest suites honestly: the matcher's own tests are **56 failed / 134
passed** (stale — your CI runs SonarQube only, never the tests, so they've drifted). Not a
production problem, but it means those tests aren't a safety net; I wrote our own instead.

---

## What I need from you

### A. Decisions (quick confirmations)
1. **Approach:** build the crypto vertical on the existing **MMP** (house quotes + this hedge
   sidecar), not a new AMM. Confirm?
2. **Hedge instrument:** perps hedge the continuous delta but **cannot** cover the digital's
   terminal/pin risk at expiry (proven in testing). Are we OK shipping perp-only first, with an
   options overlay as a later phase?
3. **Scope of first deploy:** read-only observe mode in QA first (no orders), then demo-perp.

### B. One platform change
4. **Publish `MMP_MARKET_META_{marketId}`** for `feedId=3` markets — a small JSON blob
   `{ underlyingSymbol, strike, expiryTs, feedId }` in predictor Redis. It's the only thing the
   hedger needs that the MMP doesn't already write. Everything else is read from keys you already
   maintain.
5. **Confirm `predictor_active_markets` is the authoritative live-market index in prod.** My
   scalable read path iterates that set. If liveness is tracked differently in prod, point me at
   the right index.

### C. Access (read-only)
6. **Read-only access to QA Redis** (`qa-redis.…ap-south-1.cache.amazonaws.com`). It's
   VPC-internal, so I'll need either the service deployed **inside the VPC** (same subnet/SG), a
   bastion, or a read-replica endpoint — your call on the safest path.
7. **A Binance demo/testnet API key** (futures-trade scope only, no withdrawal) for the paper
   hedge venue — or confirm you want me to use my own demo account.
8. **PR sign-off** when we're ready: the sidecar needs zero changes to your repos; the only PRs
   are the crypto market pieces + the `MMP_MARKET_META` publish (item 4).

---

## Suggested path
Observe-only in QA (read real inventory, place nothing) → validate the delta against real flow →
demo-perp with the kill-switch → costed A/B (needs a join with your settlement P&L) → review.
Nothing touches real money or production at any step.
