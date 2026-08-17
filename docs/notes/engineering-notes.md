> Engineering notes carried over from working sessions. Findings, root
> causes and decisions recorded as they were made — kept because the
> reasoning behind a fix is usually harder to recover than the fix.

`~/gb-crypto-hedging-service` (git, own repo) is the productionized hedging service —
extracts amm-hedging's logic as a deployable **read-only sidecar** for GameBull's crypto
(feed-3) LMSR markets. Decided: standalone repo, TS + Fastify, reads inventory via the
MMP_LMSR_* Redis key contract (so the SAME GamebullInventorySource adapter runs locally and
in prod). Reads only (MMP_LMSR_QUANTITY_*, MMP_MARKET_META_*, spot CRYPTO_SPOT_BTCUSDT);
never writes GameBull stores. Mainnet Binance hosts hard-blocked in `src/config.ts`; secrets
only in .env. Node at ~/.local/node/bin (use `export PATH` first).

**Structure:** `src/config.ts`, `core/{digital,gate,hedger}` (hedger behind an
`ExecutionVenue` interface), `inventory/{types,gamebull}`, `venue/{types,dry-run}`,
`loop.ts`, `http/server.ts`, `index.ts`. `CLAUDE.md` + `docs/{architecture,roadmap,
inventory-contract,execution-venue,security,ops-runbook}.md`. Roadmap phases 0–5 in
docs/roadmap.md.

**Phase 0 DONE (committed 9284d83):** boots, connects local-stack Redis, `/health` +
`/state` (shows live spot), `npm run selftest` proves inventory→gate→hedger→dry-run-venue
end-to-end (house short YES 5000 → δ −4.57 → gate arms → SELL 0.159 BTC clamped to $10k cap;
sports feed-1 market skipped). `npm run typecheck` clean.

**Phase 1 DONE (committed ff7fbe6):** `drivers/inventory-mirror` in [[gamebull-local-stack]]
publishes bb_pending_bids house matched net → MMP_LMSR_QUANTITY_{YES,NO}_* (`--watch` = every
2s). CRITICAL sign mapping: `qYes=houseNo, qNo=houseYes` so the adapter's (qYes−qNo)·dp/dS
OFFSETS the house exposure (getting it backwards DOUBLES risk). Service reads it via the real
GamebullInventorySource; added `MIN_SIGMA_PER_SEC` floor (default 4e-5) so cold vol history
doesn't degenerate dp/dS (gate still sees raw vol). Verified live: house short-YES 95 → δ +0.31
→ gate armed → hedger LONG 0.159 BTC (clamped to $10k cap); expired markets skipped; direction
correct (short YES loses when spot rises → LONG offsets).

**Phase 2 DONE (committed acea8c3):** `venue/binance-demo.ts` = ExecutionVenue port of
amm-hedging `binance.ts` (mark/positionRisk/filters/market order + fill-price lookup/leverage/
multiAssets); mainnet re-asserted at construction; index constructs it, `prepare()`s leverage+
multiAssets, flattens orphan on startup, observe-only when no keys. Verified: mainnet FUTURES_BASE
refuses to start; no-keys boot observe-only. Live testnet fills need demo BINANCE_API_KEY/SECRET
in .env (USER must provide) — code path complete + key-gated.

**Phase 3 DONE (committed 6b1b1f1):** control plane in `http/server.ts` — GET /metrics
(Prometheus gauges), POST /config (runtime Gate.setOpts + enable/disable, no redeploy), POST
/kill (flatten to 0 + disable, idempotent; loop holds flat after). buildServer takes {loop,gate,
hedger,venue}. Verified live. (Also reconfirmed sign: user buys NO → house long YES → δ<0 → SHORT hedge.)

**Phase 4 DONE (committed 3f5979e):** `core/ledger.ts` ServiceLedger — clock-aligned per-window
(LEDGER_WINDOW_MS, default 5min) HEDGE-side metrics (hedge P&L, fees, fills, slippage, exposure
mean/max, armed frac, position), CSV-persisted (data/ledger.csv) + preloaded; GET /ledger + GET
/report. gb-crypto-local dashboard hedge panel now reads the service /state as source of truth
(fallback to inline computeHedge estimate if down; shows venue/armed/δ/position/P&L). NOTE: the
full hedged-vs-unhedged BOOK A/B needs a JOIN of this hedge ledger with the exchange's per-window
settlement P&L (distribution engine) — separate analytics job, service only owns the hedge side.

**Phase 5 DONE (committed 1239483):** Dockerfile (node:22-slim, non-root, /health HEALTHCHECK,
tsx runtime, writable /app/data) + .dockerignore + docker-compose.yml (host Redis, secrets via
.env at runtime); tsx moved to runtime deps; ServiceLedger resilient to read-only FS (DATA_DIR
env, memory-only fallback); FLATTEN_ON_SHUTDOWN policy; ops/alerts.yml (Prometheus rules);
docs/deploy.md. VERIFIED: `docker build` + container boots HEALTHY against host redis (/health ok,
/metrics scraping, HEALTHCHECK healthy). Docker daemon 29.6 present.

**QA HARDENING DONE (committed 461d501):** built adversarial test suite (`npm run qa` = typecheck
+ 25 node:test tests + selftest + their Jest suites reported honestly/not gated). Found & FIXED 3
REAL production risks: (1) CRITICAL adapter used Redis `KEYS` (blocks shared prod Redis every poll)
→ now reads `predictor_active_markets` SET via smembers (RedisLike exposes smembers NOT keys);
(2) HIGH inventory-mirror DynamoDB Scan didn't paginate (1MB cap → silent under-hedge) → now loops
LastEvaluatedKey; (3) MEDIUM digitalProb(spot=0)=NaN / Infinity injection → guards + safeNum.
`docs/qa-plan.md` lists what's NOT covered (real flow, real settlement A/B, live testnet fills,
mirror sign-mapping not unit-tested, predictor_active_markets prod-authority unconfirmed, races,
per-market Query optimization). Their matcher Jest: 56 fail/134 pass (their drift). Live integration
re-verified after the KEYS→smembers refactor.

**⚠️ CRITICAL UNRESOLVED (found by checking the RIGHT branch):** our local integration ran the
matcher on branch `PRE`, which has NO LMSR code (0 `MMP_LMSR_QUANTITY` refs). The real crypto/LMSR
code is on `feat/lmsr` + `QA` only. RESOLVED (traced market-match-maker `feat/lmsr/src/utils/lmsrHelper.js`): `MMP_LMSR_QUANTITY_YES/NO_
{marketId}` ARE the LMSR pricing state — price = `calcLMSRPrice(get(qYes),get(qNo))` softmax(q/b),
b=volatility=500. So our adapter reads the RIGHT keys and `(qYes−qNo)·dp/dS` is the correct SHAPE/
direction (I over-alarmed earlier — it is NOT the wrong signal). Written by matcher + trading-api via
`incrby(bidCount×bidAmount)`. Three OPEN questions affect hedge SIZE not direction: (a) UNITS — q is
notional cents (count×price), confirm share-vs-notional scaling; (b) CUMULATIVE — nothing decrements
these keys in any feat/lmsr repo (no sell path), so cumulative ≈ net only if no intra-window sells;
(c) SEED — initializeLMSRQuantities preloads startOption1Q/2Q (synthetic liquidity, not real risk) →
subtract before hedging. These are the #0 Paras ask. Local integration ran matcher branch PRE which
LACKS LMSR code; real code is feat/lmsr/QA. Their matcher Jest on feat/lmsr = 78 fail/109 pass; QA = 79 fail/111
pass (stale mocks: code calls redisClient.incrby, mock only has hincrby — the "drift").

**ALL 6 PHASES DONE — service is feature-complete (but inventory contract needs real-data validation, see above).** Roadmap remaining is env-specific only:
actual staging deploy next to GameBull QA (needs QA Redis creds + Binance demo keys in .env), and
the platform team publishing MMP_MARKET_META for feed-3 (the one Paras/Stage-1 ask). Optional
follow-up: the full hedged-vs-unhedged BOOK A/B = join this hedge ledger with the exchange
distribution-engine per-window settlement P&L (separate analytics job). See [[amm-hedging-project]],
[[options-hedging-idea]], [[gamebull-integration]], [[gamebull-local-stack]].

**Naming disambiguation:** this file's "Phase 0-5" = the sidecar's own build
phases (all done, above). [[cross-market-hedging-phase0]] is a SEPARATE,
later research question run in this same repo — whether concurrently-open
markets can hedge each other's gamma — with its own unrelated "Phase 0" gate
(NO-GO result on pipeline-verification-grade data). Don't conflate the two
when citing "Phase 0" from memory.
