// Per-window ledger of the HEDGE side — what this service owns and can measure:
// hedge P&L, fees, fills, slippage, exposure, armed fraction. Windows align to a
// fixed clock boundary (default 5min, matching the markets' tenor). The book's
// vig/settlement P&L lives on the exchange (distribution engine); a full
// hedged-vs-unhedged A/B joins this ledger with that settlement per window.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const LEDGER_COLUMNS = [
  'window_start', 'window_end', 'ticks', 'armed_ticks', 'armed_frac',
  'hedge_pnl', 'fees', 'fills', 'notional_traded', 'slippage',
  'exposure_mean', 'exposure_max', 'vol_mean', 'position_close',
] as const;

export type LedgerRow = Record<(typeof LEDGER_COLUMNS)[number], number | string>;

// cumulative hedger counters sampled each tick (monotonic).
export interface HedgerCumulative {
  hedgePnl: number;
  feesPaid: number;
  fillCount: number;
  notionalTraded: number;
  slippagePaid: number;
}

export interface TickInput {
  now: number;
  armed: boolean;
  notionalUsdt: number; // |δ|·spot exposure this tick
  realizedVol: number;
  position: number;
  cum: HedgerCumulative;
}

export class ServiceLedger {
  private windowMs: number;
  private csv: string;
  private rowsMem: LedgerRow[] = [];

  // current window accumulation
  private idx = -1; // clock-window index
  private startTs = 0;
  private ticks = 0;
  private armedTicks = 0;
  private exposureSum = 0;
  private exposureMax = 0;
  private volSum = 0;
  private base: HedgerCumulative | null = null; // cumulatives at window open
  private persist = true; // false ⇒ memory-only (read-only FS)

  constructor(windowMs = 5 * 60_000, dataDir = process.env.DATA_DIR ?? 'data') {
    this.windowMs = windowMs;
    this.csv = path.join(dataDir, 'ledger.csv');
    // Disk persistence is best-effort: on a read-only / non-writable FS the ledger
    // still runs (in memory), it just won't survive a restart.
    try {
      if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
      if (existsSync(this.csv)) {
        const lines = readFileSync(this.csv, 'utf8').trim().split('\n').slice(1);
        for (const l of lines) {
          const v = l.split(',');
          const row = {} as LedgerRow;
          LEDGER_COLUMNS.forEach((c, i) => (row[c] = i <= 1 ? (v[i] ?? '') : Number(v[i] ?? 0)));
          this.rowsMem.push(row);
        }
      } else {
        appendFileSync(this.csv, LEDGER_COLUMNS.join(',') + '\n');
      }
    } catch (e) {
      this.persist = false;
      console.warn(`[ledger] disk unavailable (${String(e).slice(0, 60)}) — running memory-only`);
    }
  }

  tick(t: TickInput): void {
    const wIdx = Math.floor(t.now / this.windowMs);
    if (this.idx === -1) this.openWindow(wIdx, t);
    else if (wIdx !== this.idx) {
      this.closeWindow(t);
      this.openWindow(wIdx, t);
    }
    this.ticks++;
    if (t.armed) this.armedTicks++;
    this.exposureSum += t.notionalUsdt;
    this.exposureMax = Math.max(this.exposureMax, t.notionalUsdt);
    this.volSum += t.realizedVol;
    this.lastTick = t;
  }

  private lastTick: TickInput | null = null;

  private openWindow(wIdx: number, t: TickInput): void {
    this.idx = wIdx;
    this.startTs = wIdx * this.windowMs;
    this.ticks = 0;
    this.armedTicks = 0;
    this.exposureSum = 0;
    this.exposureMax = 0;
    this.volSum = 0;
    this.base = { ...t.cum };
  }

  private closeWindow(t: TickInput): void {
    if (!this.base || this.ticks === 0) return;
    const b = this.base;
    const row: LedgerRow = {
      window_start: new Date(this.startTs).toISOString(),
      window_end: new Date(this.startTs + this.windowMs).toISOString(),
      ticks: this.ticks,
      armed_ticks: this.armedTicks,
      armed_frac: +(this.armedTicks / this.ticks).toFixed(4),
      hedge_pnl: +(t.cum.hedgePnl - b.hedgePnl).toFixed(4),
      fees: +(t.cum.feesPaid - b.feesPaid).toFixed(4),
      fills: t.cum.fillCount - b.fillCount,
      notional_traded: +(t.cum.notionalTraded - b.notionalTraded).toFixed(2),
      slippage: +(t.cum.slippagePaid - b.slippagePaid).toFixed(4),
      exposure_mean: +(this.exposureSum / this.ticks).toFixed(2),
      exposure_max: +this.exposureMax.toFixed(2),
      vol_mean: +(this.volSum / this.ticks).toFixed(8),
      position_close: +t.position.toFixed(6),
    };
    this.rowsMem.push(row);
    if (this.persist) {
      try {
        appendFileSync(this.csv, LEDGER_COLUMNS.map((c) => row[c]).join(',') + '\n');
      } catch { /* disk went away — keep in memory */ }
    }
  }

  rows(limit = 50): LedgerRow[] {
    return this.rowsMem.slice(-limit).reverse();
  }

  csvPath(): string {
    return this.csv;
  }

  // summary over the completed windows (hedge-side view).
  report() {
    const r = this.rowsMem;
    if (!r.length) return { windows: 0 };
    const n = (k: (typeof LEDGER_COLUMNS)[number]) => r.map((x) => Number(x[k]));
    const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
    const mean = (a: number[]) => sum(a) / a.length;
    const std = (a: number[]) => {
      const m = mean(a);
      return Math.sqrt(mean(a.map((x) => (x - m) ** 2)));
    };
    const pnl = n('hedge_pnl');
    return {
      windows: r.length,
      hedge_pnl_total: +sum(pnl).toFixed(2),
      hedge_pnl_mean: +mean(pnl).toFixed(4),
      hedge_pnl_std: +std(pnl).toFixed(4),
      fees_total: +sum(n('fees')).toFixed(2),
      fills_total: sum(n('fills')),
      slippage_total: +sum(n('slippage')).toFixed(2),
      armed_frac_mean: +mean(n('armed_frac')).toFixed(3),
      exposure_mean: +mean(n('exposure_mean')).toFixed(2),
      exposure_max: +Math.max(...n('exposure_max')).toFixed(2),
    };
  }
}
