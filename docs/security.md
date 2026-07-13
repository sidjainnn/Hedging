# Security

## Mainnet hard-block
`src/config.ts` validates every venue base URL against a mainnet blocklist
(`api.binance.com`, `fapi.binance.com`, `api1/2/3.binance.com`). If any resolves to a
production host, the service **throws at startup** and refuses to run. This build only ever
talks to demo/testnet venues.

## Secrets
- API keys live **only** in `.env` (gitignored). `.env.example` documents the surface with
  empty values. Never commit `.env`.
- Keys must be **futures-trade scope only** — no withdrawal, no transfer.
- `hasKeys()` gates all order placement; with no keys the hedger runs in observe-only mode.

## Read-only against GameBull
- The service only READS Redis (`MMP_LMSR_QUANTITY_*`, `MMP_MARKET_META_*`, spot). It opens no
  write connection to their DynamoDB, MySQL, SQS, or HTTP endpoints.
- It cannot place, cancel, or settle bids. It has no path into their order flow.

## Blast radius
- Worst case is a wrong-sized **demo** perp position — no real money, no user funds, no impact
  on GameBull's markets.
- `POST /kill` (Phase 3) flattens and disables the hedge instantly.

## What would change for production
Real-money execution is a **separate, explicitly-authorized** step: it would relax the mainnet
block for one vetted venue, add hard position/notional limits, real-key custody, and dual-control
on the kill-switch. None of that is in this build.
