// Real-time price feed over a Binance public WebSocket. Keeps the latest price in
// memory; callers read it on demand. Self-reconnecting with backoff and a staleness
// guard so a silent drop returns null (→ callers won't act on a frozen price) rather
// than a stale value. Public read-only stream; no keys. Uses Node's built-in global
// WebSocket (Node 21+), no dependency.
//
// Both streams we use carry the price in field `p`:
//   spot:  {sym}@aggTrade   (spot stream host, e.g. stream.binance.com)
//   mark:  {sym}@markPrice@1s  (futures stream host, e.g. fstream.binance.com)
//
// Hardened against SILENT stalls: a long-lived WS can go dead on the wire (NAT/
// firewall/sleep-wake) without ever firing 'close' or 'error' — the socket stays
// "open" indefinitely while no data arrives. latest() already fails safe (returns
// null once stale), but that alone leaves the feed degraded forever instead of
// recovering. A watchdog force-closes and rebuilds the connection when data goes
// stale; a generation counter stops a superseded socket's late events from
// clobbering a fresher one.

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
  private lastTs = 0;      // last time ANY message arrived (drives the stall watchdog)
  private connectAt = 0;   // when the CURRENT dial attempt started — the watchdog's
                            // fallback deadline for a connect that never delivers a
                            // first message (lastTs stays 0 the whole time otherwise)
  private backoff = 500;
  private closed = false;
  private stream: string;
  private gen = 0;         // generation counter — orphans a superseded socket's late events
  private watchdog: ReturnType<typeof setInterval> | null = null;

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

  start(): void {
    this.closed = false;
    this.connect(); // stamps connectAt itself
    // Watchdog: a stalled socket may never fire close/error while delivering
    // nothing — force a reconnect once data has been missing past staleMs.
    //
    // BUG THIS FIXES: the old guard was `if (!this.lastTs) return`, and a
    // reconnect attempt set `lastTs = 0` right before dialing — meaning if
    // THAT attempt also failed to ever deliver a first message (a connect that
    // hangs half-open, one bad DNS answer, a momentary network blip), lastTs
    // stayed 0 forever and the watchdog treated it as "still waiting on the
    // first message" indefinitely. It never fired again. Observed live: one
    // connect, one stale-triggered reconnect, then dead silence for 75+
    // minutes while connectivity itself was fine again seconds later — this
    // fed the hedger `spot: null` the whole time, so every tick fell into the
    // `if (spot && spot > 0)` guard in loop.ts and did nothing: no inventory
    // read, no gate update, no hedge action. Hedging didn't "not work" so much
    // as go permanently blind.
    //
    // Fix: track the reconnect attempt's OWN start time (connectAt) and use
    // "no message since I last tried to connect" as the trigger, not "no
    // message since the last message" — so a reconnect that never produces a
    // first message is itself retried after staleMs, not stuck waiting on an
    // event that will never come.
    this.watchdog = setInterval(() => {
      const since = this.lastTs || this.connectAt;
      if (!since) return; // start() hasn't dialed yet
      if (Date.now() - since > this.staleMs) {
        console.warn(`[feed] ${this.name} stale >${this.staleMs}ms (no message since ${this.lastTs ? 'last data' : 'last connect attempt'}) — forcing reconnect`);
        this.gen++; // orphan the stalled socket before touching it
        try { this.ws?.close(); } catch { /* ignore */ }
        this.lastTs = 0;
        this.connect(); // stamps a fresh connectAt for this attempt
      }
    }, Math.max(5_000, Math.floor(this.staleMs / 3)));
  }

  stop(): void {
    this.closed = true;
    this.gen++;
    if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; }
    try { this.ws?.close(); } catch { /* ignore */ }
  }

  private connect(): void {
    if (this.closed) return;
    const myGen = ++this.gen;
    this.connectAt = Date.now(); // every dial gets its own watchdog deadline, not just start()'s
    const ws = new WebSocket(this.stream);
    this.ws = ws;
    ws.addEventListener('open', () => {
      if (myGen !== this.gen) return;
      this.backoff = 500;
      console.log(`[feed] WS connected ${this.stream}`);
    });
    ws.addEventListener('message', (ev: MessageEvent) => {
      if (myGen !== this.gen) return;
      try {
        const p = parseFloat(JSON.parse(ev.data as string).p);
        if (p > 0) { this.price = p; this.lastTs = Date.now(); }
      } catch { /* ignore malformed frame */ }
    });
    ws.addEventListener('close', () => this.reconnect(myGen));
    ws.addEventListener('error', () => { try { ws.close(); } catch { /* ignore */ } });
  }

  private reconnect(myGen: number): void {
    if (this.closed || myGen !== this.gen) return; // already superseded — don't double-connect
    this.gen++; // invalidate this socket's further events
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
