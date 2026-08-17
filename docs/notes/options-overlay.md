> Engineering notes carried over from working sessions. Findings, root
> causes and decisions recorded as they were made — kept because the
> reasoning behind a fix is usually harder to recover than the fix.

Perps hedge the house's short-digital delta but structurally CANNOT touch terminal
gamma / pin risk — proven in the A/B: `worst window $-94.5 → $-94.5, Δ 0.0`, cost≈benefit
(risk-removed-per-$ ≈ 0). A digital's delta `φ(d)/(S·σ√τ)` blows up as τ→0 near strike and
the payoff is a step; no linear instrument covers a discontinuity. See [[amm-breakeven-economics]].

**Options are the correct instrument:** a digital paying $1 if S≥K ≈ a tight bull call
spread `[call(K−ε) − call(K+ε)]/(2ε)`. So the house's short-digital = hedge with a LONG
call spread at K. Matches the terminal payoff AND the near-strike convexity (delta
self-adjusts). Spread width ε is the replication-vs-cost knob.

**The catch for 5-min BTC binaries** (why listed options don't drop in): (1) expiry
granularity — shortest listed BTC options (Deribit 0DTE) are daily, can't match a 5-min
window; (2) strike granularity — Deribit ~$1k spacing vs our $100 ATM strike, often no
listed strike near K±ε; (3) theta — short-dated premium/spreads likely exceed the perp
cost ($542 total in the A/B).

**Realistic architecture = both, split by job:** perps for delta (cheap, linear,
continuous) + a small option overlay at the busiest strikes for gamma/tail (nearest listed
expiry, accept basis, cap the portfolio tail rather than neutralize each window).

**A/B profile inverts vs perps:** worst-window / max-drawdown IMPROVE, mean P&L WORSENS
(pay theta). Whether it's worth it depends on tail fatness under REAL directional flow —
today's near-flat sim flow makes options look like pure cost; one-sided informed flow grows
the tail so the overlay earns its premium. Ties directly to building the informed/noise flow
generator (see [[gamebull-local-stack]] hedger-replication plan).

**Update (2026-07-30):** [[cross-market-hedging-phase0]]'s NO-GO result closes off the
other candidate for hedging terminal gamma without options — concurrently-open markets
don't reliably have usable gamma available when it's needed (24.3% staggered-tenor
availability, below the 30% threshold). That leaves the options overlay as the only
still-open path to covering terminal gamma at all; the task below is now higher priority,
not just an offered extra.

**PENDING TASK (offered, not yet done):** model call-spread replication on the existing
`~/Desktop/amm-hedging/server/data/ledger.csv` — take per-window inventory + spot paths +
logged realized_vol, price a BS call-spread replication of the house digital, and show
perp-only vs perp+option-overlay side-by-side on worst-window / max-drawdown / mean-P&L
(premium-vs-tail tradeoff in dollars).
