// Execution venue abstraction — the boundary between the hedger's decisions and
// the actual perp exchange. Swapping demo→prod is swapping the implementation.
// See docs/execution-venue.md.

export type Side = 'BUY' | 'SELL';

export interface OrderResult {
  side: Side;
  qty: number; // filled quantity (absolute)
  avgPrice: number; // fill price (0 if unknown)
  dryRun: boolean;
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
  setLeverage?(x: number): Promise<void>;
}
