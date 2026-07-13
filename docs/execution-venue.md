# Execution venue

The `ExecutionVenue` interface (`src/venue/types.ts`) is the boundary between the hedger's
decisions and the actual perp exchange. Swapping demo→prod is swapping the implementation.

## Interface
```ts
interface ExecutionVenue {
  readonly name: string;
  hasKeys(): boolean;                                   // credentials present?
  getMarkPrice(): Promise<number>;                      // perp mark
  getPositionUnits(): Promise<number>;                  // signed position (BTC)
  getFilters(): Promise<VenueFilters>;                  // minQty, minNotional, stepSize
  marketOrder(side, qty, reduceOnly): Promise<OrderResult>;
  setLeverage?(x: number): Promise<void>;
}
```

## Implementations
| Name | Phase | Behaviour |
|---|---|---|
| `dry-run` | 0 | Simulates position internally, logs intended orders, places nothing. No keys. |
| `binance-demo` | 2 | Binance USDⓈ-M **demo/testnet** perp. Mainnet hosts throw at construction. |

## The hedger's contract with the venue
- **Reduce-only** on any order that moves toward/へ zero — lets sub-min-notional closes through
  and prevents accidental sign flips.
- **Deadband** (`HEDGE_DEADBAND_USDT`) — skip target wobbles smaller than this to avoid fee churn.
- **Min-notional / min-qty** — non-reducing orders must clear the venue minimums.
- **Startup reconcile** — on boot, flatten any orphan position before trading.

## Safety
- `binance-demo` validates `FUTURES_BASE` against the mainnet blocklist (`config.assertPaper`)
  and refuses to construct on a real-money host.
- No venue is given withdrawal scope; keys are futures-trade only, in `.env`.

## Prod swap
A production venue (when authorized, separate approval) implements the same interface with real
endpoints and its own risk limits. The hedger, gate, loop, and inventory code are unchanged.
