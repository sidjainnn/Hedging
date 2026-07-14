# QA Environment & Test Strategy

Structured per standard QA methodology (STLC + testing pyramid + formal techniques).
This documents HOW the hedging service is tested, in WHICH environments, and what is
proven vs. still open. It describes our real setup — no aspirational claims.

> Scope note: a perp-hedging sidecar that moves (paper) money is closer to
> "safety-critical" than "marketing page" on the context spectrum — so the strategy
> weights correctness, boundary, and failure testing over UI/exploratory testing.

---

## 1. Test environments

| Env | What it is | Data | Money | Purpose |
|---|---|---|---|---|
| **Local (unit)** | `npm run test` — pure logic, in-memory stubs | synthetic | none | fast correctness gate (pre-commit/CI) |
| **Local integration** | `gb-crypto-local` docker stack + their real services + this service | synthetic flow | none (dry-run venue) | end-to-end wiring on real engines |
| **Binance testnet** | `EXECUTION_VENUE=binance-demo` + demo keys | synthetic flow | **paper** | real perp order/fill path |
| **GameBull QA** *(pending access)* | their VPC ElastiCache + real MMP inventory | real-ish | paper hedge | validate delta against real flow |
| **Production** *(future, gated)* | real inventory | real | real (separate approval) | out of scope for this build |

Promotion is strictly left-to-right; nothing skips a stage.

## 2. Testing levels (pyramid mapping)

```
        UAT ── Paras / stakeholders in GameBull QA        [PENDING — not ours to run]
    System ── gb-crypto-local end-to-end (market→hedge→settle) + live /state check
Integration ── selftest: inventory→gate→hedger→venue; container↔Redis boot
      Unit  ── 30 adversarial tests (digital, inventory, gate, hedger, ledger, boundary)
```
Weighted bottom-heavy per the pyramid: most assurance is fast unit tests; a thin
integration/system layer proves the wiring; UAT is the human sign-off we don't own.

## 3. Techniques applied (and where)
- **Equivalence partitioning** — valid/invalid inventory classes (finite vs NaN/Infinity;
  feed-3 vs sports; live vs expired). `inventory.test`.
- **Boundary-value analysis** — thresholds tested AT/just-below/just-above, counts at
  0/1/2/many. `boundary.test` (gate arm=100, disarm=60, deadband=75, τ=0, market counts).
- **Error guessing / fault injection** — malformed JSON, `spot=0`, huge σ, read-only FS.
  `digital.test`, `inventory.test`, `ledger.test`.
- **State-transition** — gate arm↔disarm hysteresis (no flapping). `gate.test`.
- **Load/scale** — 10k markets in one poll with a single Redis-set read. `inventory.test`.

## 4. STLC as applied here
1. **Requirement analysis** — see §5 traceability (each requirement is a testable claim).
2. **Test planning** — this doc + `qa-plan.md` (coverage + explicit non-coverage).
3. **Test design** — `test/*.test.ts` (unit/boundary), `selftest.ts` (integration).
4. **Environment setup** — `docker compose` (gb-crypto-local), `Dockerfile` (service).
5. **Execution** — `npm run qa` (typecheck → unit → selftest → their Jest, reported).
6. **Reporting** — test runner output + this doc; production risks logged in `qa-plan.md`.
7. **Closure** — 3 real defects found & fixed with regression tests (see §6).

## 5. Requirements traceability

| # | Requirement (must-hold) | Test(s) |
|---|---|---|
| R1 | Never block prod Redis (no `KEYS`) | `inventory` SCALE (single `smembers`) |
| R2 | Hedge OFFSETS house exposure (sign) | `inventory` SIGN short-YES→LONG / short-NO→SHORT |
| R3 | Exposures net across markets | `inventory` NETTING |
| R4 | Malformed/bad data never crashes or poisons aggregate | `inventory` SAFETY, `digital` grid |
| R5 | Only feed-3/BTC/live markets hedged | `inventory` FILTER, `boundary` expiry |
| R6 | Position never exceeds notional cap | `hedger` cap-clamp |
| R7 | No fee churn inside deadband | `hedger` deadband, `boundary` deadband |
| R8 | Closes are reduce-only; flatten reaches 0 | `hedger` reduce-only/flatten |
| R9 | Gate arms/disarms with hysteresis, no flap | `gate`, `boundary` arm/disarm |
| R10 | Hedge P&L exact & correctly signed | `hedger` P&L |
| R11 | Ledger survives read-only FS | `ledger` read-only |
| R12 | Delta math always finite | `digital` grid |

## 6. Defect log (found → fixed → regression-tested)
| ID | Severity | Defect | Fix | Guarding test |
|---|---|---|---|---|
| D1 | Critical | Redis `KEYS` blocks server at scale | read `predictor_active_markets` set | R1 |
| D2 | High | DynamoDB Scan unpaginated → under-hedge | paginate on `LastEvaluatedKey` | (mirror, gb-crypto-local) |
| D3 | Medium | `digitalProb(spot=0)`=NaN; Infinity inject | guard degenerate inputs → 0 | R4/R12 |

## 7. Entry / exit criteria
- **Enter integration:** unit gate green (`npm run test`), typecheck clean.
- **Enter testnet:** integration green + `/health` healthy in container.
- **Enter GameBull QA:** testnet observe-only proven + kill-switch tested; VPC read access granted.
- **Exit any stage:** no open Critical/High defects; new code has a regression test.

## 8. Defect workflow
Found → reproduce with a failing test → fix → test goes green → keep the test (regression).
Every fix in §6 followed this. Production risks that can't be unit-tested (real flow, real
settlement, live fills) are tracked as explicit non-coverage in `qa-plan.md`, not closed.

## 9. What this environment CANNOT prove (see qa-plan.md §"NOT covered")
Real order flow, real settlement A/B, live testnet fills, the JS mirror's sign mapping,
`predictor_active_markets` prod-authority, concurrency races. Green here ≠ flawless in prod.
