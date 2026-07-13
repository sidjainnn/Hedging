// The "when to hedge" logic, extracted from amm-hedging's runner. Two gates that
// must BOTH be open to hedge:
//   • vol gate      — realized per-tick return stdev ≥ threshold (with hysteresis).
//   • inventory gate — |notional exposure| ≥ an adaptive threshold (percentile of
//                      the last hour of samples, floored) — "hedge only the
//                      riskiest X% of periods" holds in any regime.
// Calm/low-inventory ⇒ not armed ⇒ the loop flattens to 0 (no fee churn).

export type IdleReason = 'armed' | 'idle-vol' | 'idle-inv' | 'disabled';

export interface GateOpts {
  volGate: boolean;
  volThreshold: number;
  volHysteresis: number;
  mode: 'adaptive' | 'fixed';
  notionalFloor: number; // HEDGE_NOTIONAL_USDT
  pctl: number;
}

export interface GateStatus {
  armed: boolean;
  idleReason: IdleReason;
  volGateOn: boolean;
  invGateOn: boolean;
  effectiveGate: number;
  realizedVol: number;
  notionalUsdt: number;
}

// ~1h of samples at 1 tick/sec; adaptive gate needs ≥300 (5min) before it leaves the floor.
const HIST_MAX = 3600;
const HIST_WARMUP = 300;

export class Gate {
  private opts: GateOpts;
  private volGateOn = false;
  private invGateOn = false;
  private effectiveGate: number;
  private notionalHist: number[] = [];

  constructor(opts: GateOpts) {
    this.opts = opts;
    this.effectiveGate = opts.notionalFloor;
  }

  setOpts(patch: Partial<GateOpts>): void {
    this.opts = { ...this.opts, ...patch };
  }

  // realizedVol = stdev of recent per-tick simple returns; notionalUsdt = |δ|·spot.
  update(realizedVol: number, notionalUsdt: number, hedgeEnabled: boolean): GateStatus {
    const o = this.opts;

    // ── vol gate (hysteresis) ──────────────────────────────────────────────
    if (!o.volGate) {
      this.volGateOn = true; // vol gate disabled ⇒ always open, lean on inventory
    } else {
      const on = o.volThreshold;
      const off = o.volThreshold * o.volHysteresis;
      if (!this.volGateOn && realizedVol >= on) this.volGateOn = true;
      else if (this.volGateOn && realizedVol < off) this.volGateOn = false;
    }

    // ── inventory gate (adaptive percentile + hysteresis) ──────────────────
    this.notionalHist.push(notionalUsdt);
    if (this.notionalHist.length > HIST_MAX) this.notionalHist.shift();
    const floor = o.notionalFloor;
    if (o.mode === 'adaptive' && this.notionalHist.length >= HIST_WARMUP) {
      const sorted = [...this.notionalHist].sort((a, b) => a - b);
      const idx = Math.min(sorted.length - 1, Math.floor(o.pctl * sorted.length));
      this.effectiveGate = Math.max(floor, sorted[idx] ?? floor);
    } else {
      this.effectiveGate = floor;
    }
    if (!this.invGateOn && notionalUsdt >= this.effectiveGate) this.invGateOn = true;
    else if (this.invGateOn && notionalUsdt < this.effectiveGate * 0.6) this.invGateOn = false;

    // ── merge ──────────────────────────────────────────────────────────────
    const armed = hedgeEnabled && this.volGateOn && this.invGateOn;
    const idleReason: IdleReason = !hedgeEnabled
      ? 'disabled'
      : !this.volGateOn
        ? 'idle-vol'
        : !this.invGateOn
          ? 'idle-inv'
          : 'armed';

    return {
      armed,
      idleReason,
      volGateOn: this.volGateOn,
      invGateOn: this.invGateOn,
      effectiveGate: this.effectiveGate,
      realizedVol,
      notionalUsdt,
    };
  }
}
