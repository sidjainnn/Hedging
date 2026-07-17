// Real-time price feed over a Binance public WebSocket. Keeps the latest price in
// memory; callers read it on demand. Self-reconnecting with backoff and a staleness
// guard so a silent drop returns null (→ callers won't act on a frozen price) rather
// than a stale value. Public read-only stream; no keys. Uses Node's built-in global
// WebSocket (Node 21+), no dependency.
//
// Both streams we use carry the price in field `p`:
//   spot:  {sym}@aggTrade   (spot stream host, e.g. stream.binance.com)
//   mark:  {sym}@markPrice@1s  (futures stream host, e.g. fstream.binance.com)

export interface PriceFeed {
  readonly name: string;
  latest(): number | null; // freshest price, or null if stale / not-yet-connected
  start(): void;
  stop(): void;
}

export class BinanceWsPriceFeed implements PriceFeed {
  readonly name: string;
  private ws: WebSocket | null = null;
  private price = 0;
  private lastTs = 0;
  private backoff = 500;
  private closed = false;
  private stream: string;

  // streamSuffix e.g. 'aggTrade' or 'markPrice@1s'
  constructor(symbol: string, streamSuffix: string, wsBase: string, private staleMs = 15_000) {
    this.name = `binance-ws:${streamSuffix}`;
    this.stream = `${wsBase}/ws/${symbol.toLowerCase()}@${streamSuffix}`;
  }

  latest(): number | null {
    if (!this.price) return null;
    if (Date.now() - this.lastTs > this.staleMs) return null; // stale → don't act on it
    return this.price;
  }

  start(): void { this.closed = false; this.connect(); }
  stop(): void { this.closed = true; try { this.ws?.close(); } catch { /* ignore */ } }

  private connect(): void {
    if (this.closed) return;
    const ws = new WebSocket(this.stream);
    this.ws = ws;
    ws.addEventListener('open', () => { this.backoff = 500; console.log(`[feed] WS connected ${this.stream}`); });
    ws.addEventListener('message', (ev: MessageEvent) => {
      try {
        const p = parseFloat(JSON.parse(ev.data as string).p);
        if (p > 0) { this.price = p; this.lastTs = Date.now(); }
      } catch { /* ignore malformed frame */ }
    });
    ws.addEventListener('close', () => this.reconnect());
    ws.addEventListener('error', () => { try { ws.close(); } catch { /* ignore */ } });
  }

  private reconnect(): void {
    if (this.closed) return;
    setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, 15_000);
  }
}

// Spot feed convenience (aggTrade).
export class BinanceWsSpotFeed extends BinanceWsPriceFeed {
  constructor(symbol: string, wsBase = 'wss://stream.binance.com:9443', staleMs = 15_000) {
    super(symbol, 'aggTrade', wsBase, staleMs);
  }
}
