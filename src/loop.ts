// The control loop: each tick reads spot, estimates realized vol, polls house
// inventory, runs the gate, and reconciles the venue position to the target delta
// (aggregate δ while armed, else flat). Holds the latest snapshot for /state.
import type { InventorySource, AggregateInventory } from './inventory/types.js';
import type { ExecutionVenue } from './venue/types.js';
import { DryRunVenue } from './venue/dry-run.js';
import { Gate, type GateStatus } from './core/gate.js';
import { Hedger } from './core/hedger.js';
import type { ServiceLedger } from './core/ledger.js';
import type { ExposureRecorder } from './core/exposure-recorder.js';
import { linearTaper } from './core/taper.js';

export interface LoopDeps {
  inventory: InventorySource;
  venue: ExecutionVenue;
  gate: Gate;
  hedger: Hedger;
  getSpot: () => Promise<number | null>;
  intervalSec: number;
  volWindow: number;
  minSigmaPerSec: number;
  ledger?: ServiceLedger;
  // Phase 0 feasibility instrumentation only — see exposure-recorder.ts header.
  // Undefined unless RECORD_EXPOSURE=true; no effect on gate/hedger behavior.
  exposureRecorder?: ExposureRecorder;
  // Deadband taper: tight (small $) far from expiry — gamma is cheap there,
  // worth reacting to real signal fast — loosening toward `deadbandLooseUsdt`
  // as the nearest active market's τ shrinks toward `deadbandRefSec`, where
  // gamma makes chasing small moves mostly fee churn on a position about to
  // resolve itself. Falls back to a flat `deadbandTightUsdt` (no active
  // markets, or all past the taper window).
  deadbandTightUsdt: number;
  deadbandLooseUsdt: number;
  deadbandRefSec: number;
  // Fraction of aggregate delta to actually hedge (see config.ts for the
  // break-even table). Optional: undefined behaves as 1.0, so an older Deps
  // object cannot silently disable hedging by omitting it.
  hedgeFraction?: number;
}

export interface LoopState {
  ts: number;
  tick: number;
  spot: number | null;
  sigmaPerSec: number;
  inventory: AggregateInventory | null;
  gate: GateStatus | null;
  hedger: { enabled: boolean; livePosition: number; hedgePnl: number; feesPaid: number; fillCount: number; lastError: string | null };
  venue: string;
  lastError: string | null;
  deadbandUsdt: number | null; // this tick's tapered deadband — null when no active market to taper against
  // Skew-offset: dollar-offset ratio (same aggregation as the ASC815/IFRS9
  // hedge-effectiveness "dollar-offset method") of how much of the liquidity
  // skew (target delta from house inventory) was actually neutralized by the
  // live hedge position, accumulated since the last /reset. 1 (100%) when no
  // skew has existed yet to offset — see Loop.tick()'s accumulation.
  skewOffsetPct: number;      // TIME-WEIGHTED coverage ratio (dimensionless, valid)
  // Fraction of aggregate delta being hedged (1 = full delta). Surfaced for
  // the same reason as inventory.deltaCurve: a hedge size means nothing
  // without knowing what fraction of the exposure it was aiming at.
  hedgeFraction: number;
  targetUsdt: number;         // CURRENT tick: |target| exposure in USDT
  residualUsdt: number;       // CURRENT tick: |target - position| left unhedged
  cumTargetUsdt: number;      // integral, NOT a dollar level — see note at accumulation
  cumResidualUsdt: number;
}

export class Loop {
  private deps: LoopDeps;
  private prices: number[] = [];
  private timer: NodeJS.Timeout | null = null;
  private tickN = 0;
  private cumTargetAbsUsdt = 0;
  private cumResidualAbsUsdt = 0;
  private lastTargetUsdt = 0;
  private lastResidualUsdt = 0;
  state: LoopState;

  constructor(deps: LoopDeps) {
    this.deps = deps;
    this.state = {
      ts: Date.now(), tick: 0, spot: null, sigmaPerSec: 0, inventory: null, gate: null,
      hedger: { enabled: deps.hedger.enabled, livePosition: 0, hedgePnl: 0, feesPaid: 0, fillCount: 0, lastError: null },
      venue: deps.venue.name, lastError: null, deadbandUsdt: null,
      skewOffsetPct: 1, hedgeFraction: 1, targetUsdt: 0, residualUsdt: 0, cumTargetUsdt: 0, cumResidualUsdt: 0,
    };
  }

  // Clears the skew-offset accumulators without touching the live position —
  // same "New round" reset pattern as Hedger.resetStats().
  resetSkewStats(): void {
    this.cumTargetAbsUsdt = 0;
    this.cumResidualAbsUsdt = 0;
  }

  // Seconds to the SOONEST-expiring active market, or null if none — that
  // market's gamma is the most urgent, so it's what should govern how
  // aggressively we chase small moves right now.
  private nearestTauSec(inv: AggregateInventory): number | null {
    if (!inv.markets.length) return null;
    const now = Date.now();
    return Math.min(...inv.markets.map((m) => (m.expiryTs - now) / 1000));
  }

  // realized vol = stdev of the last `volWindow` per-tick simple returns.
  private realizedVol(): number {
    const p = this.prices;
    if (p.length < 3) return 0;
    const rets: number[] = [];
    for (let i = 1; i < p.length; i++) rets.push((p[i]! - p[i - 1]!) / p[i - 1]!);
    const m = rets.reduce((a, b) => a + b, 0) / rets.length;
    return Math.sqrt(rets.reduce((a, b) => a + (b - m) ** 2, 0) / rets.length);
  }

  async tick(): Promise<void> {
    const d = this.deps;
    this.tickN++;
    try {
      const spot = await d.getSpot();
      if (spot && spot > 0) {
        this.prices.push(spot);
        if (this.prices.length > d.volWindow) this.prices.shift();
      }
      const volPerTick = this.realizedVol();
      // per-second vol for the digital delta (returns are sampled every intervalSec),
      // floored so cold vol history doesn't degenerate dp/dS. The vol GATE below
      // still sees the raw per-tick vol.
      const sigmaPerSec = Math.max(volPerTick / Math.sqrt(Math.max(d.intervalSec, 1)), d.minSigmaPerSec);

      let inv: AggregateInventory | null = null;
      let gate: GateStatus | null = null;
      let deadbandUsdt: number | null = null;
      let markPrice: number | null = null;
      // Hoisted so /state can report it even on a tick with no usable spot.
      const frac = Number.isFinite(d.hedgeFraction as number) ? Math.max(0, Math.min(1, d.hedgeFraction as number)) : 1;
      if (spot && spot > 0) {
        inv = await d.inventory.poll(spot, sigmaPerSec, Date.now());
        d.exposureRecorder?.record(inv.markets, spot, Date.now());
        gate = d.gate.update(volPerTick, inv.notionalUsdt, d.hedger.enabled);

        // dry-run venue needs the current mark to simulate fills.
        if (d.venue instanceof DryRunVenue) d.venue.setMark(spot);

        // Sizing/execution basis fix: the digital's delta (inv.aggregateDelta,
        // just above) is correctly computed off SPOT — that's what the
        // market's payoff actually depends on. But the hedge itself executes
        // as a real order on the PERP (binance-demo hits /fapi's futures
        // market), which trades at spot +/- a funding-driven basis (measured
        // live 2026-07-24: spot $65,425.09 vs perp mark $65,395.30, ~4.5bps).
        // Feeding `spot` into reconcile/flatten as `markPrice` was sizing the
        // notional cap, deadband threshold, and fees off a price the order
        // never actually fills at — a small but real and *systematic* error
        // (ledger showed ~5.6bps average slippagePaid, in line with this).
        // Use the venue's own mark (real perp mark for binance-demo, the
        // spot-mirrored mark just set above for dry-run) for everything
        // downstream of "how big an order, at what price" instead.
        markPrice = await d.venue.getMarkPrice().catch(() => spot);

        const tauSec = this.nearestTauSec(inv);
        deadbandUsdt = tauSec == null
          ? d.deadbandTightUsdt
          : linearTaper(tauSec, d.deadbandRefSec, d.deadbandTightUsdt, d.deadbandLooseUsdt);

        // Scale the target by the configured fraction. Applied BEFORE the
        // hedger's notional clamp and deadband so both see the size we
        // actually intend to hold, not the full delta we are choosing not to.
        const target = gate.armed ? inv.aggregateDelta * frac : 0;
        if (gate.armed) await d.hedger.reconcile(target, markPrice, deadbandUsdt);
        else await d.hedger.flatten(markPrice);

        // Skew-offset accumulation — measured AFTER reconcile/flatten so
        // livePosition reflects this tick's hedge action, not last tick's.
        // Dollar-offset ratio (Σ|residual| / Σ|target|) rather than a
        // per-tick ratio: a per-tick ratio divides by zero the instant
        // target hits 0 between markets and is dominated by whichever tick
        // happens to run last, not by how much skew was actually at risk.
        const residual = target - d.hedger.livePosition;
        // Point-in-time exposure — this is the number that means something in
        // dollars and the one the UI should show.
        this.lastTargetUsdt = Math.abs(target) * markPrice;
        this.lastResidualUsdt = Math.abs(residual) * markPrice;
        // Running integrals. These exist ONLY to form skewOffsetPct (a ratio, so
        // the units cancel). They are NOT dollar levels: each is a sum over
        // ticks, so they grow without bound with uptime and DOUBLE if the loop
        // interval is halved — units are effectively dollar-ticks. They were
        // previously surfaced in the UI as "$X skew seen", which read as a
        // position size: with ~$1.7M of exposure held for an hour this shows
        // ~$3.06 BILLION, against markets whose total possible payout was under
        // $2,000. Kept for the ratio, but must not be displayed as money.
        this.cumTargetAbsUsdt += this.lastTargetUsdt;
        this.cumResidualAbsUsdt += this.lastResidualUsdt;

        d.ledger?.tick({
          now: Date.now(), armed: gate.armed, notionalUsdt: inv.notionalUsdt,
          realizedVol: volPerTick, position: d.hedger.livePosition,
          cum: {
            hedgePnl: d.hedger.hedgePnl(markPrice), feesPaid: d.hedger.feesPaid, fillCount: d.hedger.fillCount,
            notionalTraded: d.hedger.notionalTraded, slippagePaid: d.hedger.slippagePaid,
          },
        });
      }

      this.state = {
        ts: Date.now(), tick: this.tickN, spot, sigmaPerSec, inventory: inv, gate,
        hedger: {
          enabled: d.hedger.enabled, livePosition: d.hedger.livePosition,
          hedgePnl: markPrice ? d.hedger.hedgePnl(markPrice) : 0, feesPaid: d.hedger.feesPaid,
          fillCount: d.hedger.fillCount, lastError: d.hedger.lastError,
        },
        venue: d.venue.name, lastError: null, deadbandUsdt,
        skewOffsetPct: this.cumTargetAbsUsdt > 0
          ? Math.max(0, Math.min(1, 1 - this.cumResidualAbsUsdt / this.cumTargetAbsUsdt))
          : 1,
        hedgeFraction: frac,
        targetUsdt: this.lastTargetUsdt, residualUsdt: this.lastResidualUsdt,
        cumTargetUsdt: this.cumTargetAbsUsdt, cumResidualUsdt: this.cumResidualAbsUsdt,
      };
    } catch (e) {
      this.state.lastError = String(e);
    }
  }

  start(): void {
    if (this.timer) return;
    const run = () => void this.tick();
    run();
    this.timer = setInterval(run, this.deps.intervalSec * 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
