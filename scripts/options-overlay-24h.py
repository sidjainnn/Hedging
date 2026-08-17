#!/usr/bin/env python3
"""
Options overlay for LONG-DATED (24h+) windows — feasibility test.

THE QUESTION
------------
A perp provably cannot hedge a binary's terminal gamma (architecture PDF §8.1):
Gamma is identically zero for a linear instrument, and a digital's payoff is a
step. The theoretically correct hedge is a tight CALL SPREAD, which matches both
the terminal payoff and the near-strike convexity:

    digital(K) paying $1  ~=  [ call(K - w/2) - call(K + w/2) ] / w

THE CATCH, AND WHY TENOR IS THE WHOLE STORY
-------------------------------------------
That replication is only as good as w is SMALL relative to the terminal move.
The listed strike grid is FIXED (~$500 near the money on Deribit) while the
terminal move scales with sqrt(T). So w/sigma FALLS as the window lengthens:

    5 min   w/sigma = 5.07   the "spread" is a naked call — hedges nothing
    1 hour  w/sigma = 1.46   marginal
    24 hour w/sigma = 0.30   usable

This is the precise reason the options overlay is viable for a 24h book and NOT
for the 5-minute book, and it is a property of the listed market, not of our
implementation. Nothing lists at a 5-minute expiry at any strike spacing.

WHAT THIS SCRIPT MEASURES
-------------------------
1. Replication error of the real, tradeable call spread vs the digital payoff,
   over real BTC 24h windows.
2. Execution cost using REAL Deribit quotes, compared against what hedging the
   same window with perps would cost.

Run:  python3 scripts/options-overlay-24h.py
"""
import csv, json, math, os, statistics as st, sys, urllib.request, datetime as dt

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/140.0 Safari/537.36")
DERIBIT = "https://www.deribit.com/api/v2/public"
PX = "/Users/sidharthjain/gb-crypto-kronos/data/btcusdt_5m_train.csv"
BARS_24H = 288          # 288 x 5m = 24h
N_CONTRACTS = 1786      # same reference position used throughout the hedging docs
TAKER_PERP = 4 / 1e4


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=25) as r:
        return json.loads(r.read().decode())


def load_chain():
    """Live Deribit chain. Cached to /tmp so repeat runs don't re-hit the API."""
    cache = "/tmp/deribit_chain.json"
    if not os.path.exists(cache):
        d = get(f"{DERIBIT}/get_book_summary_by_currency?currency=BTC&kind=option")
        open(cache, "w").write(json.dumps(d))
    rows = json.load(open(cache))["result"]
    idx = get(f"{DERIBIT}/get_index_price?index_name=btc_usd")["result"]["index_price"]
    return idx, rows


MON = {m: i + 1 for i, m in enumerate(
    ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"])}


def parse(rows, idx):
    """-> {expiry: {strike: {'C': (bid_usd, ask_usd), ...}}}. Deribit quotes in
    BTC; everything downstream is USD, so convert once here."""
    out = {}
    for r in rows:
        p = r["instrument_name"].split("-")
        if len(p) != 4:
            continue
        try:
            d = p[1]
            exp = dt.datetime(2000 + int(d[-2:]), MON[d[-5:-2]], int(d[:-5]), 8, 0, tzinfo=dt.timezone.utc)
        except Exception:
            continue
        k, cp = float(p[2]), p[3]
        b, a = r.get("bid_price") or 0, r.get("ask_price") or 0
        out.setdefault(exp, {}).setdefault(k, {})[cp] = (b * idx, a * idx)
    return out


def call_spread_cost(chain_exp, k_lo, k_hi):
    """USD cost of BUYING the spread, and the pure spread-CROSSING component.

    The premium itself is not a 'cost' — it buys an asset with matching payoff.
    What the hedge actually costs relative to fair value is the half-spread paid
    on each leg, which is what is compared against the perp's taker fee."""
    lo, hi = chain_exp.get(k_lo, {}).get("C"), chain_exp.get(k_hi, {}).get("C")
    if not lo or not hi or not all(x > 0 for x in (*lo, *hi)):
        return None
    lo_mid, hi_mid = sum(lo) / 2, sum(hi) / 2
    debit = lo[1] - hi[0]                     # buy lower at ASK, sell upper at BID
    fair = lo_mid - hi_mid
    return {"debit": debit, "fair": fair, "crossing": debit - fair,
            "max_payoff": k_hi - k_lo}


def main():
    idx, rows = load_chain()
    chain = parse(rows, idx)
    now = dt.datetime.now(dt.timezone.utc)
    # nearest expiry at least 24h out — the instrument a 24h book would hedge with
    cands = sorted(e for e in chain if (e - now).total_seconds() >= 24 * 3600)
    if not cands:
        print("no expiry >= 24h out"); return
    exp = cands[0]
    hrs = (exp - now).total_seconds() / 3600
    print(f"BTC index ${idx:,.0f}   hedging expiry {exp:%d%b%y} (T+{hrs:.1f}h)\n")

    # ---- pick the tightest tradeable spread straddling the money -------------
    ks = sorted(k for k in chain[exp] if chain[exp][k].get("C"))
    atm = min(ks, key=lambda k: abs(k - idx))
    below = [k for k in ks if k < atm]
    above = [k for k in ks if k > atm]
    if not below or not above:
        print("no straddling strikes"); return
    k_lo, k_hi = max(below), min(above)
    c = call_spread_cost(chain[exp], k_lo, k_hi)
    if not c:
        print(f"strikes {k_lo}/{k_hi} not two-sided — cannot price the spread"); return

    w = c["max_payoff"]
    print(f"tightest tradeable spread: BUY {k_lo:.0f}C / SELL {k_hi:.0f}C   width ${w:.0f}")
    print(f"  debit (crossing both)     ${c['debit']:>8.1f} per BTC")
    print(f"  fair value (mid-to-mid)   ${c['fair']:>8.1f}")
    print(f"  CROSSING COST             ${c['crossing']:>8.1f}   <- the real cost of the hedge\n")

    # Size: a spread of width w pays at most $w, so $1 of digital payoff needs
    # 1/w of a spread. N contracts of $1 payoff -> N/w spreads.
    spreads = N_CONTRACTS / w
    opt_cost = spreads * c["crossing"]
    print(f"to hedge {N_CONTRACTS} binary contracts (max loss ${N_CONTRACTS:,}):")
    print(f"  spreads needed            {spreads:>8.2f}")
    print(f"  OPTIONS crossing cost     ${opt_cost:>8.0f}   ONCE, held to expiry")

    # ---- perp comparison over the same 24h ----------------------------------
    # A perp hedge must be REBALANCED as delta moves; the options spread does not.
    sigma_sec = 0.5 / math.sqrt(365 * 24 * 3600)
    tau = 24 * 3600
    # digital delta at the money, 24h out
    dpdS = (1 / (idx * sigma_sec * math.sqrt(tau))) * 0.3989422804
    perp_units = N_CONTRACTS * dpdS
    perp_notional = abs(perp_units) * idx
    one_way = perp_notional * TAKER_PERP
    print(f"\n  PERP equivalent delta     {perp_units:>8.2f} BTC  (${perp_notional:,.0f} notional)")
    print(f"  perp cost, enter+exit     ${2*one_way:>8.0f}   MINIMUM (zero rebalancing)")
    for n in (4, 12, 48):
        print(f"  perp cost, {n:>2} rebalances  ${2*one_way + n*one_way:>8.0f}")

    # ---- replication error over real BTC 24h windows -------------------------
    with open(PX) as fh:
        rd = csv.DictReader(fh)
        px = [float(r["close"]) for r in rd]
    REBAL_BARS = 12          # re-delta every hour (12 x 5m) over the 24h window
    MAX_NOTIONAL = 10_000    # same cap the live service runs
    dig_pnl, err, perp_err, dyn_err, dyn_fee = [], [], [], [], []
    for i in range(0, len(px) - BARS_24H, BARS_24H):   # NON-overlapping windows
        s0, s1 = px[i], px[i + BARS_24H]
        K = s0                                          # ATM market, as generated
        lo, hi = K - w / 2, K + w / 2
        # House is SHORT the digital: it collected p0 and pays $1 if YES wins.
        p0 = 0.5                                        # ATM
        house = N_CONTRACTS * p0 - N_CONTRACTS * (1.0 if s1 >= K else 0.0)
        # Options overlay: LONG the call spread, which pays what the house owes.
        sp = (N_CONTRACTS / w) * max(0.0, min(s1 - lo, w))
        sp_paid = spreads * c["fair"]                   # premium paid up front
        # STATIC perp hedge over the SAME windows.
        perp = perp_units * (s1 - s0)
        dig_pnl.append(house)
        err.append(house + sp - sp_paid)
        perp_err.append(house + perp)

        # DYNAMICALLY REBALANCED perp — the fair comparison. A static perp is a
        # strawman: its tail blows out only because it never re-sizes. Re-delta
        # every REBAL_BARS using the real intra-window path, and charge the
        # taker fee on each adjustment so the cost is not hidden.
        pos, cash, fee = 0.0, 0.0, 0.0
        for j in range(i, i + BARS_24H, REBAL_BARS):
            s = px[j]
            tau_left = max((i + BARS_24H - j) * 300, 60)     # seconds
            d_j = 0.3989422804 / (s * sigma_sec * math.sqrt(tau_left))
            tgt = N_CONTRACTS * d_j
            # cap at the same budget the live service uses, else 24h ATM delta
            # near expiry demands a position no desk would actually hold
            tgt = max(-MAX_NOTIONAL / s, min(MAX_NOTIONAL / s, tgt))
            dq = tgt - pos
            cash -= dq * s
            fee += abs(dq) * s * TAKER_PERP
            pos = tgt
        cash += pos * px[i + BARS_24H]
        dyn_err.append(house + cash - fee)
        dyn_fee.append(fee)
    n = len(err)
    ae = [abs(x - st.mean(err)) for x in err]
    sd_un, sd_opt, sd_perp = st.pstdev(dig_pnl), st.pstdev(err), st.pstdev(perp_err)
    print(f"\nHEDGE COMPARISON — {n} non-overlapping real 24h windows, same position")
    print(f"  {'':24}{'SD of P&L':>12}{'risk removed':>14}")
    print(f"  {'unhedged':24}${sd_un:>11.0f}{'--':>14}")
    print(f"  {'perp delta hedge':24}${sd_perp:>11.0f}{100*(1-sd_perp/sd_un):>13.1f}%")
    sd_dyn = st.pstdev(dyn_err)
    print(f"  {'perp, hourly rebalance':24}${sd_dyn:>11.0f}{100*(1-sd_dyn/sd_un):>13.1f}%   (fees ${st.mean(dyn_fee):.0f}/window)")
    print(f"  {'options call spread':24}${sd_opt:>11.0f}{100*(1-sd_opt/sd_un):>13.1f}%   (cost ${opt_cost:.0f}/window)")
    worst_un = min(dig_pnl); worst_opt = min(err); worst_perp = min(perp_err)
    print(f"\n  worst window   unhedged ${worst_un:>7.0f} | perp static ${worst_perp:>7.0f} | perp hourly ${min(dyn_err):>7.0f} | options ${worst_opt:>7.0f}")
    print(f"  (the options overlay's job is precisely this tail — the pin, where")
    print(f"   a perp is structurally blind)")

    # ---- the number that actually decides it --------------------------------
    be_opt = 100 * opt_cost / N_CONTRACTS
    print(f"\nBREAK-EVEN SPREAD (what the book must charge to fund its own hedge)")
    print(f"  options overlay, 24h window   {be_opt:>6.1f}c per contract")
    print(f"  full perp hedge, 5m window      24.0c   (measured previously)")
    print(f"  -> the SAME hedging budget is ~{24.0/be_opt:.1f}x easier to fund at 24h,")
    print(f"     because the hedge is bought ONCE and held, not rebalanced every")
    print(f"     5 minutes against a delta that diverges as tau -> 0.")

    # ---- expiry alignment ---------------------------------------------------
    print(f"\nEXPIRY ALIGNMENT — a free design win, and a REQUIREMENT for exact replication")
    print(f"  Deribit expiries are DAILY at 08:00 UTC. This chain's is {exp:%d %b %H:%M} UTC.")
    print(f"  A 24h BitBull window generated at an arbitrary wall-clock time expires")
    print(f"  MID-OPTION-LIFE, leaving the spread with residual time value at our")
    print(f"  settlement — so the payoff match above would NOT hold in production.")
    print(f"  Generating the 24h market to expire AT 08:00 UTC makes the replication")
    print(f"  exact and costs nothing. This is the single most important")
    print(f"  implementation detail in this whole analysis.")


if __name__ == "__main__":
    main()
