# Inventory contract (read-only)

The exact Redis surface the service reads. All keys are **read**; the service never writes them.

## Keys
| Key | Type | Meaning |
|---|---|---|
| `MMP_LMSR_QUANTITY_YES_{marketId}` | string (number) | House YES-share inventory for the market |
| `MMP_LMSR_QUANTITY_NO_{marketId}`  | string (number) | House NO-share inventory |
| `MMP_MARKET_META_{marketId}` | string (JSON) | `{ underlyingSymbol, strike, expiryTs, feedId }` |
| `CRYPTO_SPOT_BTCUSDT` (`SPOT_REDIS_KEY`) | string (JSON) | `{ price }` — the underlying spot from the oracle feed |

Key prefixes are configurable (`MMP_LMSR_KEY_YES`, `MMP_LMSR_KEY_NO`, `MMP_MARKET_META_KEY`).

## MarketMeta
```jsonc
{
  "underlyingSymbol": "BTCUSDT",  // must equal SYMBOL to be hedged
  "strike": 63000,                // K for the digital
  "expiryTs": 1783929567028,      // ms epoch; τ = (expiryTs − now)/1000
  "feedId": 3                     // must be in HEDGEABLE_FEED_IDS (crypto/non-sports)
}
```
A market is hedged only if: meta exists, `feedId ∈ HEDGEABLE_FEED_IDS`,
`underlyingSymbol === SYMBOL`, and `τ > 0` (not expired). Otherwise it's counted in `skipped`.

## Discovery
Active markets are discovered by scanning `MMP_LMSR_QUANTITY_YES_*` and slicing the prefix
off to recover `marketId`. No separate index is required.

## Delta
```
τ      = (expiryTs − now) / 1000                     seconds to expiry
dp/dS  = digitalDelta(spot, strike, σ_perSec, τ)     core/digital.ts
δ_mkt  = (qYes − qNo) · dp/dS                         BTC-equivalent
δ_agg  = Σ δ_mkt over hedgeable markets
```

## Who publishes these
- **Prod:** GameBull's MMP already maintains `MMP_LMSR_QUANTITY_*`. The one addition needed is
  `MMP_MARKET_META_*` for feed-3 markets (the platform ask).
- **Local:** the `inventory-mirror` driver in `gb-crypto-local` derives house net from
  `bb_pending_bids` matched counts and writes the `MMP_LMSR_QUANTITY_*` keys, so this service
  runs the **same adapter** locally that it will run in prod. `MMP_MARKET_META_*` is already
  published by the local `market-generator`.

## Why the mirror (not read bb_pending_bids directly)
Running the real `GamebullInventorySource` against the same key contract locally means there
is no local-only code path — the thing validated locally is exactly the thing deployed.
