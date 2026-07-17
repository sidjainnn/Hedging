# QA Test-Case Specification — gb-crypto-hedging-service

Formal specification of every automated test (STLC "Test Cases" deliverable). Each case lists
its objective, precondition, input, expected result, the requirement it covers (R# from
`qa-environment.md`), and the technique applied. All are **automated** (Node test runner).

- **Run:** `npm run test` (all 30) · `npm run qa` (typecheck → tests → selftest → their Jest)
- **Suite:** 6 files, 30 cases, current status **30/30 PASS**
- **Levels:** unit + component (see `qa-environment.md` §2 pyramid)
- **Techniques:** EP = equivalence partitioning · BVA = boundary-value analysis ·
  EG = error guessing/fault injection · ST = state transition · SC = scale/load

| ID | Objective | Precondition | Input | Expected result | Req | Tech | Status |
|----|-----------|--------------|-------|-----------------|-----|------|--------|
| **TC-DIG-01** | Delta math never returns NaN/Infinity | — | grid: spot {0,1e-9,1,63000,1e9} × strike × σ {0…1e6} × τ {−10…1e7} | `p` finite ∈[0,1]; `dpdS` finite ≥0 for all | R12 | EP+BVA | PASS |
| **TC-DIG-02** | ATM prices ~0.5 with usable delta | — | spot=strike=63000, σ=4e-5, τ=300 | p≈0.5 (±0.05); dpdS>0 finite | R12 | EP | PASS |
| **TC-DIG-03** | Tails price to 0/1 with ~0 delta | — | spot 80000 & 50000 vs K=63000 | ITM p>0.99, OTM p<0.01; both dpdS<1e-3 | R12 | EP | PASS |
| **TC-DIG-04** | Near-expiry ATM doesn't blow to ∞ | — | spot=strike, τ=1e-9 | dpdS finite (pin-risk singularity guarded) | R12 | BVA | PASS |
| **TC-INV-01** | House short YES → LONG hedge (offsets) | active market, feed-3 | qYes=5000, qNo=0 | aggregateDelta > 0 (→ LONG) | R2 | EP | PASS |
| **TC-INV-02** | House short NO → SHORT hedge (offsets) | active market, feed-3 | qYes=0, qNo=5000 | aggregateDelta < 0 (→ SHORT) | R2 | EP | PASS |
| **TC-INV-03** | Opposite exposures net across markets | 2 active markets | mkt A short-YES, mkt B short-NO, equal | aggregateDelta ≈ 0; 2 markets returned | R3 | EP | PASS |
| **TC-INV-04** | Malformed data skipped, aggregate finite | active markets | bad qty ("NaN","Infinity"), broken JSON meta, missing fields | no throw; aggregate & notional finite; ≥2 skipped | R4 | EG | PASS |
| **TC-INV-05** | Only feed-3/BTC/live markets hedged | mixed markets | sports feed-1, ETH symbol, expired, live BTC | only live BTC feed-3 hedged; 3 skipped | R5 | EP | PASS |
| **TC-INV-06** | Scale: 10k markets, one Redis-set read (no KEYS) | 10k active markets | 10k markets w/ qty+meta | completes; exactly 1 `smembers` call; aggregate finite | R1 | SC | PASS |
| **TC-GATE-01** | Disabled hedger never arms | — | enabled=false, high vol+notional | armed=false; idleReason="disabled" | R9 | ST | PASS |
| **TC-GATE-02** | Inventory gate arm/disarm w/ hysteresis | fixed mode, floor=100 | notional 50→150→70→50 | idle → armed → stays armed (band) → idle | R9 | ST+BVA | PASS |
| **TC-GATE-03** | Vol + inventory gates both required | volGate on | vol below/above threshold, notional high | idle-vol → armed → armed (band) → idle-vol | R9 | ST | PASS |
| **TC-GATE-04** | Adaptive gate ≈ 60th percentile after warmup | adaptive mode | 1000 samples spanning 0..999 | effectiveGate ∈ (500,700); ≥ floor | R9 | ST | PASS |
| **TC-GATE-05** | Adaptive gate holds floor during warmup | adaptive, floor=250 | 1 sample (< warmup) | effectiveGate = 250 | R9 | BVA | PASS |
| **TC-HED-01** | Position clamped to notional cap | maxNotional=10k | target 10 BTC (over budget) | \|position×price\| ≤ 10k; went long | R6 | BVA | PASS |
| **TC-HED-02** | Deadband suppresses tiny wobbles | deadband=75 | target ≈ $31 move | no order placed | R7 | BVA | PASS |
| **TC-HED-03** | Reduce-only on closes; flatten reaches 0 | open long first | reconcile down, then flatten | last order reduceOnly=true; position ≈ 0 | R8 | EP | PASS |
| **TC-HED-04** | Disabled hedger places nothing | enabled=false | reconcile 0.15 | 0 orders | R9 | ST | PASS |
| **TC-HED-05** | No-keys venue is observe-only | venue.keys=false | reconcile 0.15 | 0 orders | R6 | EG | PASS |
| **TC-HED-06** | Hedge P&L exact and correctly signed | long 0.1 @ 63000 | mark 63000 / 64000 / 62000 | P&L 0 / +100 / −100 (±5) | R10 | EP | PASS |
| **TC-HED-07** | P&L finite over many reconciles | small deadband | 2000 reconciles, oscillating mark/target | hedgePnl & fees finite; fees ≥ 0 | R10 | SC | PASS |
| **TC-LED-01** | Windows roll on clock boundary; diff correct | windowMs=1000 | ticks in window 0 then window 1 | window 0 row: ticks=2; hedge_pnl = close−open | R11 | BVA | PASS |
| **TC-LED-02** | Report summarizes with finite stats | 5 windows | 2 ticks/window ×5 | windows≥4; mean/std finite | R11 | EP | PASS |
| **TC-LED-03** | Read-only FS → memory-only, no crash | unwritable dir | construct + tick across a boundary | no throw; rows recorded in memory | R11 | EG | PASS |
| **TC-BND-01** | Gate arm boundary (floor=100) | fixed mode | notional 99.99 / 100.00 / 100.01 | idle / armed / armed | R9 | BVA | PASS |
| **TC-BND-02** | Gate disarm boundary (0.6×floor=60) | armed first | notional 60.00 / 59.99 | stays armed / disarms | R9 | BVA | PASS |
| **TC-BND-03** | Deadband boundary ($75) | deadband=75 | move $74.9 / $75.01 | skipped / order fires | R7 | BVA | PASS |
| **TC-BND-04** | Market-count boundary (0/1/2/many) | — | 0, 1, 2 active markets | 0→flat, 1→one, 2→sums; no crash | R5 | BVA | PASS |
| **TC-BND-05** | Expiry boundary (τ=0 vs 1ms) | one market | expiryTs = now / now+1 | τ=0 skipped; 1ms left hedged | R5 | BVA | PASS |

## Coverage by requirement
| Req | Covered by |
|---|---|
| R1 no KEYS (scale) | TC-INV-06 |
| R2 hedge sign offsets | TC-INV-01/02 |
| R3 netting | TC-INV-03 |
| R4 bad data safe | TC-INV-04, TC-DIG-01 |
| R5 market filtering | TC-INV-05, TC-BND-04/05 |
| R6 cap clamp | TC-HED-01/05 |
| R7 deadband | TC-HED-02, TC-BND-03 |
| R8 reduce-only/flatten | TC-HED-03 |
| R9 gate/hysteresis | TC-GATE-01…05, TC-BND-01/02 |
| R10 P&L exact/signed | TC-HED-06/07 |
| R11 ledger | TC-LED-01/02/03 |
| R12 finite delta | TC-DIG-01/02/03/04 |

## Not covered by these cases (see qa-plan.md)
LMSR inventory scaling (units/cumulative/seed — needs team confirm), real order flow, real
settlement A/B, live testnet fills, the JS mirror's sign mapping, concurrency races. Green on
the 30 cases above validates internal logic + scale-safety, **not** production correctness on
real data.

## Defect history (found → fixed → regression-guarded)
| ID | Defect | Now guarded by |
|---|---|---|
| D1 | Redis `KEYS` blocks server at scale | TC-INV-06 |
| D2 | DynamoDB Scan unpaginated (mirror) | — (mirror is JS in gb-crypto-local; manual) |
| D3 | `digitalProb(spot=0)`=NaN / Infinity inject | TC-DIG-01, TC-INV-04 |
