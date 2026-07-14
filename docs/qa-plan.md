# QA plan & honest coverage

Run everything: `npm run qa` (typecheck → adversarial unit tests → selftest → their Jest
suites, reported honestly). Our gate must be green; their suites are informational.

## Production risks FOUND and FIXED while building this
Real defects, not hypotheticals — each would surface at scale/production:

1. **`KEYS` blocked Redis (CRITICAL).** The adapter scanned `MMP_LMSR_QUANTITY_YES_*` with
   Redis `KEYS` — O(N) over the whole keyspace, which **blocks the server**. On GameBull's
   shared prod Redis (millions of keys) that freezes every service each poll. **Fixed:** read
   the `predictor_active_markets` set (O(active markets), non-blocking). Test: `inventory` SCALE.
2. **DynamoDB Scan didn't paginate (HIGH).** The mirror read `bb_pending_bids` in one Scan;
   DynamoDB caps a page at 1MB, so past ~thousands of bids it silently read partial data →
   **under-hedge**. **Fixed:** paginate on `LastEvaluatedKey` (`gb-crypto-local` mirror).
3. **NaN/Infinity delta (MEDIUM).** `digitalProb(spot=0,…)` returned `NaN` (0/0); a malformed
   inventory value could inject `Infinity`. A non-finite delta silently disables OR blows up
   the hedge. **Fixed:** `digitalProb` guards degenerate inputs → 0 delta; adapter drops
   non-finite deltas + `safeNum` on quantities. Tests: `digital` grid, `inventory` SAFETY.

See `docs/qa-environment.md` for the full test strategy (levels, environments, techniques,
traceability, entry/exit criteria).

## What IS covered (30 adversarial tests)
- **digital** — output finite & `p∈[0,1]` across a degenerate grid (spot 0/huge, σ 0/huge,
  τ negative/0/huge); near-expiry ATM doesn't blow to Infinity.
- **inventory** — SIGN (short YES→LONG, short NO→SHORT, offsets); NETTING across markets;
  malformed meta/quantities skipped; wrong feed/symbol/expired filtered; **10k-market scale**
  with a single `smembers` call.
- **gate** — arm/disarm, vol + inventory hysteresis (no flapping), adaptive percentile,
  floor during warmup, disabled.
- **hedger** — position **clamped to the notional cap**, deadband suppresses churn, reduce-only
  on closes, flatten reaches zero, disabled/no-keys observe-only, **exact & correctly-signed
  P&L**, finite over 2000 reconciles.
- **ledger** — windows roll on clock boundaries, correct diffs, read-only-FS → memory-only.
- **boundary** — boundary-value analysis: gate arm (=100), disarm (=60), deadband (=75),
  expiry (τ=0 vs 1ms), market counts (0/1/2/many) tested AT and on both sides of each threshold.
- **selftest** — full inventory→gate→hedger→venue wiring, plus a live check against the stack.

## What is NOT covered — needs their real QA or more work (do not assume safe)
Being explicit so nobody mistakes green for "flawless":

0. **Inventory source CONFIRMED; scaling/interpretation open.** Verified against the REAL
   `feat/lmsr` code: `MMP_LMSR_QUANTITY_YES/NO_{marketId}` ARE the LMSR pricing state — the price
   is `calcLMSRPrice(get(qYes), get(qNo))` (`market-match-maker/src/utils/lmsrHelper.js`). So our
   adapter reads the RIGHT keys and `(qYes−qNo)·dp/dS` is the correct SHAPE (matches the MM's
   settlement-value delta; sign/direction correct). THREE open questions affect hedge SIZE, not
   direction: (a) **units** — `q` is `Σ bidCount×bidAmount` = notional cents (bidAmount is price,
   5–95¢), and `b=volatility=500` is calibrated to that scale; confirm the correct share-vs-notional
   scaling. (b) **cumulative** — nothing decrements these keys in any feat/lmsr repo (no sell path),
   so `q` is cumulative over the market life, ≈ net only if no intra-window sells. (c) **seed** —
   `initializeLMSRQuantities` pre-loads `q` with `startOption1Q/2Q` (synthetic liquidity, not real
   risk) → likely subtract before hedging. NOTE: we integrated locally against matcher branch `PRE`,
   which LACKS the LMSR code; the real code is `feat/lmsr`/`QA`. Confirm (a)/(b)/(c) with the team
   before trusting hedge magnitude on real data.
1. **Real order flow.** All inventory is synthetic (our drivers). Real user behavior, bid
   sizes, and skew distributions are unknown → the gate calibration and hedge magnitude are
   only validated on our model, not production flow.
2. **Real settlement P&L / true A/B.** The ledger measures the **hedge side only**. The
   hedged-vs-unhedged **book** verdict needs a join with the exchange's per-window settlement
   P&L (distribution engine) — not built.
3. **Live perp fills.** `binance-demo` order placement is ported but **not exercised against a
   live testnet** (needs demo keys). Real fills, partial fills, rate limits, and rejects are
   unverified.
4. **The mirror's sign mapping** (`qYes=houseNo`, `qNo=houseYes`) is verified live against the
   dashboard, but the mirror is JS in `gb-crypto-local` and is **not unit-tested** here. A
   regression there would flip the hedge. → port it under test before prod.
5. **`predictor_active_markets` authority.** The scalable adapter assumes this set is the
   authoritative live-market index in prod. **Confirm with the platform team** — if prod
   maintains liveness differently, the adapter needs the real index.
6. **Concurrency/races.** Node is single-threaded but `POST /kill` can interleave with an
   in-flight `reconcile` (both await). Not stress-tested for a double-order race.
7. **Per-market Query at scale.** The mirror now paginates (correct) but still full-Scans
   `bb_pending_bids`; at millions of bids that's slow/costly — a per-market GSI Query is the
   real fix, not done.
8. **Redis/venue failure injection, feed-staleness end-to-end, key rotation, backpressure** —
   partially handled in code (guards, alerts) but not covered by automated failure tests.

## Their Jest suites (informational, reported by `npm run qa`)
Matcher: 56 failed / 134 passed (their own test drift). Distribution: suites fail to run in
our setup (build/config). We do **not** gate on these — they're their code, shown for honesty.
