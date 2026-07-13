// Reconciles the live venue position to the target delta. Ported from
// amm-hedging's hedger, with the exchange calls behind the ExecutionVenue
// interface. Handles reduce-only, min-notional, deadband, and exact hedge P&L
// (avg-entry + realized) so per-window attribution is precise.
import type { ExecutionVenue, OrderResult } from '../venue/types.js';

export interface HedgeAction {
  ts: number;
  targetUnits: number;
  positionUnits: number;
  order: OrderResult | null;
  note: string;
}

const TAKER_BPS = 4; // Binance USDⓈ-M taker fee ≈ 0.04%

export interface HedgerOpts {
  maxNotionalUsdt: number;
  deadbandUsdt: number;
}

export class Hedger {
  enabled: boolean;
  livePosition = 0;
  lastError: string | null = null;
  log: HedgeAction[] = [];
  feesPaid = 0;
  fillCount = 0;
  notionalTraded = 0;
  slippagePaid = 0;
  private avgEntry = 0;
  private realizedHedge = 0;

  constructor(private venue: ExecutionVenue, private opts: HedgerOpts, enabled = false) {
    this.enabled = enabled;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
  }

  // realized + unrealized hedge P&L marked at `mark`.
  hedgePnl(mark: number): number {
    return this.realizedHedge + this.livePosition * (mark - this.avgEntry);
  }

  private applyFillPnl(posBefore: number, signedFill: number, price: number): void {
    const newPos = posBefore + signedFill;
    if (posBefore === 0 || Math.sign(signedFill) === Math.sign(posBefore)) {
      this.avgEntry = newPos !== 0 ? (posBefore * this.avgEntry + signedFill * price) / newPos : 0;
    } else {
      const closed = Math.min(Math.abs(signedFill), Math.abs(posBefore));
      this.realizedHedge += Math.sign(posBefore) * closed * (price - this.avgEntry);
      if (Math.abs(signedFill) > Math.abs(posBefore)) this.avgEntry = price;
      else if (newPos === 0) this.avgEntry = 0;
    }
  }

  async refreshPosition(): Promise<void> {
    if (!this.venue.hasKeys()) return;
    try {
      this.livePosition = await this.venue.getPositionUnits();
      this.lastError = null;
    } catch (e) {
      this.lastError = String(e);
    }
  }

  // Hold the target while armed; clamp to the notional budget.
  async reconcile(targetUnits: number, markPrice: number): Promise<void> {
    if (!this.enabled || !this.venue.hasKeys()) return;
    const cap = this.opts.maxNotionalUsdt / markPrice;
    await this.moveTo(Math.max(-cap, Math.min(cap, targetUnits)), markPrice, 'order sent');
  }

  // Close to zero regardless of `enabled` — the kill path leaves no open exposure.
  async flatten(markPrice: number): Promise<void> {
    if (!this.venue.hasKeys()) return;
    await this.moveTo(0, markPrice, 'flatten', true);
  }

  private async moveTo(target: number, markPrice: number, note: string, force = false): Promise<void> {
    try {
      const f = await this.venue.getFilters();
      this.livePosition = await this.venue.getPositionUnits();
      const posBefore = this.livePosition;
      const diff = target - this.livePosition;
      const reducing =
        this.livePosition !== 0 &&
        (target === 0 || (Math.sign(target) === Math.sign(this.livePosition) && Math.abs(target) < Math.abs(this.livePosition)));
      const notionalDiff = Math.abs(diff) * markPrice;
      if (!force && notionalDiff < this.opts.deadbandUsdt) return; // deadband: skip churn
      if (Math.abs(diff) < f.minQty) return; // below lot size
      if (!reducing && notionalDiff < f.minNotional) return; // non-reduce must clear min-notional

      const order = await this.venue.marketOrder(diff > 0 ? 'BUY' : 'SELL', Math.abs(diff), reducing);
      this.feesPaid += Math.abs(order.qty || diff) * markPrice * (TAKER_BPS / 1e4);
      if (order.qty > 0) {
        this.fillCount++;
        this.notionalTraded += order.qty * markPrice;
        const fillPrice = order.avgPrice > 0 ? order.avgPrice : markPrice;
        if (order.avgPrice > 0) {
          const signed = order.side === 'BUY' ? 1 : -1;
          this.slippagePaid += (fillPrice - markPrice) * signed * order.qty;
        }
        this.applyFillPnl(posBefore, order.side === 'BUY' ? order.qty : -order.qty, fillPrice);
      }
      if (order.qty > 0 && !order.dryRun) {
        this.livePosition = await this.venue.getPositionUnits();
      } else if (order.dryRun) {
        this.livePosition += order.side === 'BUY' ? order.qty : -order.qty;
      }
      this.push({ ts: Date.now(), targetUnits: target, positionUnits: this.livePosition, order, note: order.dryRun ? 'dry-run (no order sent)' : note });
      this.lastError = null;
    } catch (e) {
      this.lastError = String(e);
      this.push({ ts: Date.now(), targetUnits: target, positionUnits: this.livePosition, order: null, note: 'ERROR: ' + e });
    }
  }

  private push(a: HedgeAction): void {
    this.log.unshift(a);
    if (this.log.length > 50) this.log.pop();
  }
}
