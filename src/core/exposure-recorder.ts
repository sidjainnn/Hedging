// Phase 0 feasibility instrumentation ONLY — see
// docs/cross-market-hedging-research-plan.md and
// .claude/plans (misty-scribbling-fountain.md). Records the per-market
// exposure/gamma series that inv.markets[] already computes every tick and
// today discards, so scripts/phase0-analysis.ts has something to read.
// Purely additive: no gate/hedger/quoting behavior depends on this file.
// Off by default — enabled via RECORD_EXPOSURE=true (see index.ts wiring).
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { HedgeableMarket } from '../inventory/types.js';

export const EXPOSURE_COLUMNS = [
  'ts', 'marketId', 'strike', 'expiryTs', 'tauSec', 'spot', 'qYes', 'qNo', 'delta', 'gamma',
] as const;

export class ExposureRecorder {
  private csv: string;
  private persist = true; // false ⇒ memory-only (read-only FS) — same fallback as ServiceLedger
  private rowsMem: string[] = [];

  constructor(dataDir = process.env.DATA_DIR ?? 'data') {
    this.csv = path.join(dataDir, 'exposure.csv');
    try {
      if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
      if (!existsSync(this.csv)) appendFileSync(this.csv, EXPOSURE_COLUMNS.join(',') + '\n');
    } catch (e) {
      this.persist = false;
      console.warn(`[exposure-recorder] disk unavailable (${String(e).slice(0, 60)}) — running memory-only`);
    }
  }

  // One row per live market this tick. `now` is the same tick timestamp the
  // loop already has (Date.now() at poll time) so rows join cleanly against
  // the hedge ledger's windows if that's ever useful.
  record(markets: HedgeableMarket[], spot: number, now: number): void {
    for (const m of markets) {
      const tauSec = (m.expiryTs - now) / 1000;
      const line = [
        now, m.marketId, m.strike, m.expiryTs, tauSec.toFixed(3), spot, m.qYes, m.qNo,
        m.delta.toExponential(6), m.gamma.toExponential(6),
      ].join(',');
      if (this.persist) {
        try {
          appendFileSync(this.csv, line + '\n');
          continue;
        } catch { /* disk went away mid-run — fall through to memory */ }
      }
      this.rowsMem.push(line);
    }
  }
}
