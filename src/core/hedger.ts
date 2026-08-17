// Reconciles the live venue position to the target delta. Ported from
// amm-hedging's hedger, with the exchange calls behind the ExecutionVenue
// interface. Handles reduce-only, min-notional, deadband, and exact hedge P&L
// (avg-entry + realized) so per-window attribution is precise.
import type { ExecutionVenue, OrderResult, Side } from '../venue/types.js';

export interface HedgeAction {
  ts: number;
  targetUnits: number;
  positionUnits: number;
  order: OrderResult | null;
  note: string;
}

const TAKER_BPS = 4; // Binance USDⓈ-M taker fee ≈ 0.04%
const MAKER_BPS = 2; // Binance USDⓈ-M maker fee ≈ 0.02% — half the taker rate

export interface HedgerOpts {
  maxNotionalUsdt: number;
  deadbandUsdt: number;
  // Try to POST the hedge (maker, ~half the fee) before crossing the spread.
  // Off by default: this changes the money path, and the taker path is the
  // known-good one. See docs — hedge fees, not direction, are what make a
  // full-size hedge uneconomic, so this roughly DOUBLES the hedge fraction a
  // given spread can fund.
  preferMaker?: boolean;
  // How long to let a posted order rest before giving up on it and crossing.
  makerTimeoutMs?: number;
}

export const DEFAULT_MAKER_TIMEOUT_MS = 1500;

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

  // Zero the cumulative performance counters WITHOUT touching the live
  // position — used by the app's "New round" reset so a fresh round starts from
  // a clean P&L slate. `avgEntry` is deliberately re-anchored to the current
  // mark rather than 0: leaving a stale entry price against a still-open
  // position would report a huge phantom unrealised P&L on the next tick.
  resetStats(markPrice?: number): void {
    this.feesPaid = 0;
    this.fillCount = 0;
    this.notionalTraded = 0;
    this.slippagePaid = 0;
    this.realizedHedge = 0;
    this.avgEntry = this.livePosition !== 0 && markPrice ? markPrice : 0;
    this.log = [];
    this.lastError = null;
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

  // Hold the target while armed; clamp to the notional budget. `deadbandUsdt`
  // is optional per-call so the loop can taper it with time-to-expiry
  // (tight early when gamma is cheap to chase, loose near expiry when it
  // isn't) without needing a whole new Hedger instance per market.
  async reconcile(targetUnits: number, markPrice: number, deadbandUsdt?: number): Promise<void> {
    if (!this.enabled || !this.venue.hasKeys()) return;
    const cap = this.opts.maxNotionalUsdt / markPrice;
    await this.moveTo(Math.max(-cap, Math.min(cap, targetUnits)), markPrice, 'order sent', false, deadbandUsdt);
  }

  // Close to zero regardless of `enabled` — the kill path leaves no open exposure.
  async flatten(markPrice: number): Promise<void> {
    if (!this.venue.hasKeys()) return;
    await this.moveTo(0, markPrice, 'flatten', true);
  }

  private async moveTo(target: number, markPrice: number, note: string, force = false, deadbandOverride?: number): Promise<void> {
    try {
      const f = await this.venue.getFilters();
      this.livePosition = await this.venue.getPositionUnits();
      const posBefore = this.livePosition;
      const diff = target - this.livePosition;
      const reducing =
        this.livePosition !== 0 &&
        (target === 0 || (Math.sign(target) === Math.sign(this.livePosition) && Math.abs(target) < Math.abs(this.livePosition)));
      const notionalDiff = Math.abs(diff) * markPrice;
      const deadband = deadbandOverride ?? this.opts.deadbandUsdt;
      if (!force && notionalDiff < deadband) return; // deadband: skip churn
      if (Math.abs(diff) < f.minQty) return; // below lot size
      if (!reducing && notionalDiff < f.minNotional) return; // non-reduce must clear min-notional

      const side: Side = diff > 0 ? 'BUY' : 'SELL';
      const want = Math.abs(diff);

      // MAKER FIRST (optional): post at the touch, then complete whatever did
      // not fill by crossing. The hedge is never left short of its target just
      // because a passive order missed — a partial maker fill is completed at
      // taker in the same reconcile, not deferred to the next tick.
      const fills: OrderResult[] = [];
      let remaining = want;
      if (this.opts.preferMaker && this.venue.makerOrder) {
        const m = await this.venue.makerOrder(side, remaining, reducing, this.opts.makerTimeoutMs ?? DEFAULT_MAKER_TIMEOUT_MS);
        if (m.qty > 0) {
          fills.push({ ...m, maker: true });
          remaining = Math.max(0, remaining - m.qty);
        }
      }
      // Only cross for a remainder that is still worth an order on its own.
      if (remaining > 0 && remaining >= f.minQty && (reducing || remaining * markPrice >= f.minNotional)) {
        fills.push(await this.venue.marketOrder(side, remaining, reducing));
      }
      // Nothing executed at all (e.g. maker missed and the remainder fell under
      // the lot/notional floor) — report it rather than fabricating an order.
      if (!fills.length) {
        this.push({ ts: Date.now(), targetUnits: target, positionUnits: this.livePosition, order: null, note: 'no fill (maker missed, remainder below minimum)' });
        return;
      }

      // Aggregate the legs into one reported order so the ledger keeps one row
      // per reconcile, as it always has.
      const filledQty = fills.reduce((a, o) => a + o.qty, 0);
      const order: OrderResult = {
        side,
        qty: filledQty,
        avgPrice: filledQty > 0
          ? fills.reduce((a, o) => a + (o.avgPrice > 0 ? o.avgPrice : markPrice) * o.qty, 0) / filledQty
          : 0,
        dryRun: fills.every((o) => o.dryRun),
        maker: fills.length === 1 ? fills[0]!.maker === true : undefined,
      };
      // Fee per leg at ITS OWN rate — charging everything at taker would
      // misreport the whole point of the maker path.
      for (const o of fills) {
        const qty = o.qty || (fills.length === 1 ? want : 0);
        this.feesPaid += qty * markPrice * ((o.maker ? MAKER_BPS : TAKER_BPS) / 1e4);
      }
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
