#!/usr/bin/env python3
"""
Does it pay to KEEP a losing perp leg after its 5-minute market has settled?

THE PROPOSAL
------------
When a 5m market settles, the hedge leg is normally closed. The proposal is: if
that leg is underwater, DON'T close it — hold it until it comes back green, so
the perp book never realises a loss.

WHY IT NEEDS TESTING RATHER THAN ASSERTING
------------------------------------------
The intuition is not silly. Realised losses feel like the thing to avoid, and
BTC does mean-revert over short horizons. But two structural facts push the
other way, and only a simulation says which wins:

  1. Once the binary settles, the leg hedges NOTHING. It is a naked directional
     BTC position sized off an exposure that no longer exists.
  2. Legs ACCUMULATE. Held legs are not independent — they are all created by
     the same flow and market conditions, so they tend to be same-signed. The
     danger is not one bad leg, it is fifty correlated ones.

This measures both policies over real BTC data, and — the number that actually
matters — how much naked exposure the hold policy builds up.

Run:  python3 scripts/orphan-hold-test.py
"""
import csv, math, random, statistics as st

PX_FILE = "/Users/sidharthjain/gb-crypto-kronos/data/btcusdt_5m_train.csv"
MAX_NOTIONAL = 10_000
TAKER = 5 / 1e4
SEED = 11


def load():
    with open(PX_FILE) as fh:
        return [float(r["close"]) for r in csv.DictReader(fh)]


def run(px, hold_losers, max_hold_bars=None):
    """One pass over every 5m window.

    Each window: the house ends up skewed, we hedge it, the market settles.
    Policy A (hold_losers=False): close the leg at settlement, always.
    Policy B (hold_losers=True):  close only if green; otherwise carry it.
    """
    rnd = random.Random(SEED)
    realised = 0.0
    fees = 0.0
    per_window = []
    orphans = []                 # [units, entry_px, age_bars]
    max_orphans = 0
    max_orphan_notional = 0.0
    equity_curve = []

    for i in range(len(px) - 1):
        s0, s1 = px[i], px[i + 1]

        # House inventory skew for this window -> hedge units, capped at budget.
        # Sign is random: flow direction is assumed INDEPENDENT of the next
        # move. That is the neutral assumption and is generous to the hold
        # policy — if flow were adverse (users buying the side that wins), the
        # hold policy would look worse, not better.
        units = rnd.uniform(-1, 1) * (MAX_NOTIONAL / s0)
        fees += abs(units) * s0 * TAKER          # entry, always crossed

        pnl_leg = units * (s1 - s0)

        if not hold_losers or pnl_leg > 0:
            realised += pnl_leg
            fees += abs(units) * s1 * TAKER      # exit
        else:
            orphans.append([units, s0, 0])       # carry it

        # Walk the orphan book: close any leg now in profit.
        still = []
        for o in orphans:
            u, entry, age = o
            age += 1
            mtm = u * (s1 - entry)
            expired = max_hold_bars is not None and age >= max_hold_bars
            if mtm > 0 or expired:
                realised += mtm
                fees += abs(u) * s1 * TAKER
            else:
                still.append([u, entry, age])
        orphans = still

        gross = sum(abs(u) * s1 for u, _, _ in orphans)
        net = abs(sum(u for u, _, _ in orphans)) * s1
        max_orphans = max(max_orphans, len(orphans))
        max_orphan_notional = max(max_orphan_notional, net)

        open_mtm = sum(u * (s1 - e) for u, e, _ in orphans)
        equity_curve.append(realised + open_mtm - fees)
        per_window.append(pnl_leg)

    # Mark whatever is still open at the end — an unrealised loss is still a loss.
    final_open = sum(u * (px[-1] - e) for u, e, _ in orphans)
    return {
        "realised": realised, "fees": fees, "open_mtm": final_open,
        "total": realised + final_open - fees,
        "sd_window": st.pstdev(per_window),
        "max_orphans": max_orphans, "max_orphan_notional": max_orphan_notional,
        "left_open": len(orphans),
        "equity": equity_curve,
    }


def maxdd(curve):
    peak, dd = curve[0], 0.0
    for v in curve:
        peak = max(peak, v)
        dd = min(dd, v - peak)
    return dd


def main():
    px = load()
    print(f"{len(px):,} 5-minute bars = {len(px)*5/60/24:.0f} days of real BTC\n")

    a = run(px, hold_losers=False)
    b = run(px, hold_losers=True)
    c = run(px, hold_losers=True, max_hold_bars=288)   # give up after 24h

    rows = [("A: close every leg at settlement", a),
            ("B: hold losers until green", b),
            ("C: hold losers, force-close 24h", c)]
    print(f"{'policy':34}{'total P&L':>12}{'fees':>10}{'max DD':>11}{'legs left open':>16}")
    for name, r in rows:
        print(f"{name:34}{('$%.0f'%r['total']):>12}{('$%.0f'%r['fees']):>10}"
              f"{('$%.0f'%maxdd(r['equity'])):>11}{r['left_open']:>16,}")

    print(f"\n{'policy':34}{'max open legs':>15}{'max NET naked notional':>25}")
    for name, r in rows:
        print(f"{name:34}{r['max_orphans']:>15,}{('$%.0f'%r['max_orphan_notional']):>25}")

    print("\n--- the point ---")
    print(f"Policy A never carries naked risk: every leg dies with its market.")
    print(f"Policy B peaked at {b['max_orphans']:,} simultaneously-open legs and")
    print(f"${b['max_orphan_notional']:,.0f} of NET naked BTC exposure — against a")
    print(f"${MAX_NOTIONAL:,} hedge budget meant to cap exposure in the first place.")
    print(f"{b['left_open']:,} legs were still open at the end of the run.")


if __name__ == "__main__":
    main()
