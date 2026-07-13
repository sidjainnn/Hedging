// The control loop: each tick reads spot, estimates realized vol, polls house
// inventory, runs the gate, and reconciles the venue position to the target delta
// (aggregate δ while armed, else flat). Holds the latest snapshot for /state.
import type { InventorySource, AggregateInventory } from './inventory/types.js';
import type { ExecutionVenue } from './venue/types.js';
import { DryRunVenue } from './venue/dry-run.js';
import { Gate, type GateStatus } from './core/gate.js';
import { Hedger } from './core/hedger.js';
import type { ServiceLedger } from './core/ledger.js';

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
}

export class Loop {
  private deps: LoopDeps;
  private prices: number[] = [];
  private timer: NodeJS.Timeout | null = null;
  private tickN = 0;
  state: LoopState;

  constructor(deps: LoopDeps) {
    this.deps = deps;
    this.state = {
      ts: Date.now(), tick: 0, spot: null, sigmaPerSec: 0, inventory: null, gate: null,
      hedger: { enabled: deps.hedger.enabled, livePosition: 0, hedgePnl: 0, feesPaid: 0, fillCount: 0, lastError: null },
      venue: deps.venue.name, lastError: null,
    };
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
      if (spot && spot > 0) {
        inv = await d.inventory.poll(spot, sigmaPerSec, Date.now());
        gate = d.gate.update(volPerTick, inv.notionalUsdt, d.hedger.enabled);

        // dry-run venue needs the current mark to simulate fills.
        if (d.venue instanceof DryRunVenue) d.venue.setMark(spot);

        const target = gate.armed ? inv.aggregateDelta : 0;
        if (gate.armed) await d.hedger.reconcile(target, spot);
        else await d.hedger.flatten(spot);

        d.ledger?.tick({
          now: Date.now(), armed: gate.armed, notionalUsdt: inv.notionalUsdt,
          realizedVol: volPerTick, position: d.hedger.livePosition,
          cum: {
            hedgePnl: d.hedger.hedgePnl(spot), feesPaid: d.hedger.feesPaid, fillCount: d.hedger.fillCount,
            notionalTraded: d.hedger.notionalTraded, slippagePaid: d.hedger.slippagePaid,
          },
        });
      }

      this.state = {
        ts: Date.now(), tick: this.tickN, spot, sigmaPerSec, inventory: inv, gate,
        hedger: {
          enabled: d.hedger.enabled, livePosition: d.hedger.livePosition,
          hedgePnl: spot ? d.hedger.hedgePnl(spot) : 0, feesPaid: d.hedger.feesPaid,
          fillCount: d.hedger.fillCount, lastError: d.hedger.lastError,
        },
        venue: d.venue.name, lastError: null,
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
