// Dry-run venue — simulates fills and tracks a virtual position, places no orders.
// Phase 0 default: proves the whole loop end-to-end with no keys and no exchange.
import type { ExecutionVenue, OrderResult, Side, VenueFilters } from './types.js';

export class DryRunVenue implements ExecutionVenue {
  readonly name = 'dry-run';
  private position = 0; // simulated signed position (BTC)
  private mark = 0; // last mark fed by the loop

  // Binance BTCUSDT USDⓈ-M futures-ish minimums (demo-realistic).
  private filters: VenueFilters = { minQty: 0.001, minNotional: 5, stepSize: 0.001 };

  hasKeys(): boolean {
    return true; // dry-run needs no credentials but is allowed to "trade"
  }

  // the loop injects the current spot each tick so simulated fills mark correctly.
  setMark(price: number): void {
    this.mark = price;
  }

  async getMarkPrice(): Promise<number> {
    return this.mark;
  }

  async getPositionUnits(): Promise<number> {
    return this.position;
  }

  async getFilters(): Promise<VenueFilters> {
    return this.filters;
  }

  async marketOrder(side: Side, qty: number, _reduceOnly: boolean): Promise<OrderResult> {
    const signed = side === 'BUY' ? Math.abs(qty) : -Math.abs(qty);
    this.position += signed;
    return { side, qty: Math.abs(qty), avgPrice: this.mark, dryRun: true };
  }

  async setLeverage(_x: number): Promise<void> {
    /* no-op in dry-run */
  }
}
