// Execution venue abstraction — the boundary between the hedger's decisions and
// the actual perp exchange. Swapping demo→prod is swapping the implementation.
// See docs/execution-venue.md.

export type Side = 'BUY' | 'SELL';

export interface OrderResult {
  side: Side;
  qty: number; // filled quantity (absolute)
  avgPrice: number; // fill price (0 if unknown)
  dryRun: boolean;
  // True when this fill was a MAKER (posted, rested, got hit). Drives fee
  // accounting: the ledger previously charged every fill the taker rate, which
  // understated nothing while all orders were taker, but would silently
  // over-report fees the moment maker execution was enabled. Absent = taker.
  maker?: boolean;
}

export interface VenueFilters {
  minQty: number; // exchange lot size
  minNotional: number; // min order notional (USDT)
  stepSize: number; // quantity increment
}

export interface ExecutionVenue {
  readonly name: string;
  hasKeys(): boolean;
  getMarkPrice(): Promise<number>;
  getPositionUnits(): Promise<number>; // signed (long +, short −)
  getFilters(): Promise<VenueFilters>;
  marketOrder(side: Side, qty: number, reduceOnly: boolean): Promise<OrderResult>;
  // Post-only maker order: rest at the near touch, wait up to timeoutMs, then
  // CANCEL whatever has not filled and report only what did. Returning a
  // partial (or zero) fill is normal and expected — the caller is responsible
  // for completing the remainder, so the hedge is never left unestablished.
  //
  // Optional: venues that cannot post (or tests that do not care) simply omit
  // it and the hedger stays on the taker path.
  makerOrder?(side: Side, qty: number, reduceOnly: boolean, timeoutMs: number): Promise<OrderResult>;
  setLeverage?(x: number): Promise<void>;
}
