# Options overlay for 24h+ windows — feasibility result

**Verdict: GO, for long-dated windows only.** A listed call spread removes
**68%** of P&L dispersion on a 24h binary against **16–27%** for a perp, and it
covers the terminal-gamma tail a perp is structurally blind to. It needs a
**6.4¢** spread to fund itself, versus **24¢** for a full perp hedge on a 5m
window.

Reproduce with `python3 scripts/options-overlay-24h.py` (pulls the live Deribit
chain; falls back to a `/tmp` cache).

---

## 1. Why tenor is the entire story

A digital paying $1 at K is replicated by a call spread of width `w`:

```
digital(K)  ~=  [ call(K − w/2) − call(K + w/2) ] / w
```

That replication is good only when `w` is **small relative to the terminal
move**. The listed strike grid is fixed at **~$500** near the money; the
terminal move scales with `√T`. So `w/σ` *falls* as the window lengthens:

| window | 1σ move | tightest w | w/σ | verdict |
|---|---|---|---|---|
| 5 min | $99 | $500 | **5.07** | useless — the "spread" is a naked call |
| 15 min | $171 | $500 | 2.92 | useless |
| 1 hour | $342 | $500 | 1.46 | marginal |
| 6 hour | $838 | $500 | 0.60 | usable |
| **24 hour** | **$1,675** | **$500** | **0.30** | **usable** |

This is a property of the **listed market**, not of our implementation, and it
is not fixable by us. Nothing lists at a 5-minute expiry at any strike spacing.
It is the precise reason the options overlay is viable for a 24h book and was
never going to work for the 5m book — and it complements, rather than replaces,
§8.1's result that a perp cannot hedge terminal gamma at *any* tenor.

## 2. The instrument actually exists and is tradeable

Live Deribit chain, BTC index $64,046:

| expiry | horizon | calls | strike range | modal spacing |
|---|---|---|---|---|
| 05Aug26 | T+14.9h | 21 | $56k–70k | $500 |
| **06Aug26** | **T+38.9h** | 22 | $56k–71k | **$500** |
| 07Aug26 | T+62.9h | 23 | $53k–80k | $1000 |

Tightest tradeable spread straddling the money: **BUY 63500C / SELL 64500C**,
width $1,000.

```
debit (crossing both legs)   $570.0 per BTC
fair value (mid to mid)      $506.0
CROSSING COST                 $64.0   <- the actual cost of the hedge
```

The premium is **not** a cost — it buys an asset with a matching payoff. What
the hedge costs relative to fair value is the half-spread paid on each leg.
Conflating the two would overstate the cost by ~9×.

## 3. Measured result — 343 non-overlapping real 24h windows

Position: 1,786 contracts, ATM, house short the digital. Same windows, same
position, four treatments:

| | SD of P&L | risk removed | cost/window |
|---|---|---|---|
| unhedged | $892 | — | — |
| perp, static | $649 | 27.2% | $22 |
| perp, hourly rebalance | $748 | **16.1%** | $4 |
| **options call spread** | **$285** | **68.0%** | $114 |

Worst window: unhedged −$893 · perp static **−$3,354** · perp hourly −$895 ·
options **−$869**.

Two things worth pausing on.

**The static perp makes the tail 3.8× worse** (−$893 → −$3,354). A linear hedge
against a bounded payoff overshoots: past a certain move the binary's loss caps
while the perp's keeps growing. The options spread is the only treatment that
improves the tail at all.

**Hourly rebalancing makes the perp *worse*, not better** (27.2% → 16.1%). This
is the gamma wall showing up in a new place: re-deltaing into a diverging `dp/dS`
as τ→0 whipsaws the position, and the $10k notional cap binds hard exactly when
delta is largest. More diligent hedging with the wrong instrument is worse than
less.

## 4. The economics

```
break-even spread, options overlay on a 24h window     6.4c per contract
break-even spread, full perp hedge on a 5m window     24.0c per contract
```

**~3.7× easier to fund**, because the options hedge is bought **once and held to
expiry**, while a perp hedge is rebalanced continuously against a delta that
diverges as expiry approaches. 6.4¢ is a realistic spread for a 24h market;
24¢ on a ~54¢ contract never was.

This does not repeal §8.7. It says the fee wall is a property of **short-dated
perp hedging**, and that moving the hedged book to a long tenor with the right
instrument steps around it rather than fighting it.

## 5. Expiry alignment — the one implementation detail that matters most

Deribit BTC options expire **daily at 08:00 UTC**. A 24h market generated at an
arbitrary wall-clock time settles *mid-option-life*, leaving the spread with
residual time value at our settlement — so the payoff match in §3 would **not
hold in production**. The measured 68% assumes alignment.

Implemented as `EXPIRY_ALIGN_UTC_HOUR` in `gb-crypto-local`'s market-generator.
Unset = previous behaviour exactly. Alignment only ever *extends* a market to
the next occurrence of that hour, never shortens one:

```bash
TENOR_MIN=1440 EXPIRY_ALIGN_UTC_HOUR=8 node drivers/market-generator/index.mjs
```

Verified live: created `btc24h1785863394721`, "Will BTCUSDT be ≥ $64,130 at
08:00:00 UTC?", expiring **06Aug 08:00Z** — exactly Deribit's `BTC-6AUG26`.

## 6. A latent bug this surfaced

`app/server.mjs`'s `lifecycle()` opens a replacement market when
`live.length === 0`. It counted **every** live market, so a 24h market sitting
in `predictor_active_markets` would have suppressed 5-minute generation **for a
full day** — with the app reporting healthy throughout. Fixed by scoping the
replenish trigger to the primary tenor (`PRIMARY_TENOR_TAG`, default `5m`);
expired markets of any tenor are still settled. Verified live: the 5m market
rotated normally with the 24h market present.

## 7. Limits of this result — read before acting

* **Liquidity is thin.** Open interest at the ATM strike is ~50 contracts and
  24h volume ~37. The 1.79 spreads this position needs will fill, but a book an
  order of magnitude larger would move the market, and the $64 crossing cost
  would not survive that. **This result does not scale linearly.**
* **Option spreads are wide** — 13–16% of mid near the money, blowing out past
  60% away from it. The economics hold *only* for near-the-money strikes.
* **One chain snapshot.** Costs are from a single point in time, not an average
  over regimes. Spreads widen in stress, which is exactly when the hedge is
  wanted.
* **343 windows ≈ 344 days**, one asset, one vol regime.
* **No execution model.** Assumes the spread is bought at the quoted touch in
  one shot. No legging risk, no partial fills, no adverse selection between legs.
* **Deribit is a real-money venue.** `test.deribit.com` is reachable and is
  where any live test must run first. Nothing here has traded.
* **The 5m book is unchanged and unhelped.** This is an argument for offering a
  long-dated product, not a fix for the existing one.

## 8. What would come next

1. Paper-trade the overlay on `test.deribit.com` against the live 24h market
   already generating, and compare realised replication error to the 68% here.
2. Model legging risk — buy/sell the two strikes separately and measure slippage
   between them.
3. Re-run across several chain snapshots to get a cost *distribution* rather
   than one number.
4. Decide whether a 24h product is wanted commercially. That is a product call,
   not an engineering one, and everything above is contingent on it.
