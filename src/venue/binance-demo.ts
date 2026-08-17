// Binance USDⓈ-M DEMO/testnet perp venue. Ported from amm-hedging's binance.ts
// behind the ExecutionVenue interface. Real orders (dry-run is a separate venue),
// but the base URL is re-asserted against the mainnet blocklist so this can only
// ever talk to a demo host.
import crypto from 'node:crypto';
import { assertPaper } from '../config.js';
import { BinanceWsPriceFeed } from '../feed/binance-ws.js';
import type { ExecutionVenue, OrderResult, Side, VenueFilters } from './types.js';

export interface BinanceDemoOpts {
  apiKey: string;
  apiSecret: string;
  futuresBase: string; // e.g. https://demo-fapi.binance.com
  symbol: string;
  // Public futures mark-price WS host (read-only price, no keys). Empty = REST only.
  markWsBase?: string; // e.g. wss://fstream.binance.com
}

interface FullFilters extends VenueFilters {
  qtyPrecision: number;
  // Price-side filters, needed only by the post-only maker path.
  tickSize: number;
  pricePrecision: number;
}

export class BinanceDemoVenue implements ExecutionVenue {
  readonly name = 'binance-demo';
  private opts: BinanceDemoOpts;
  private filtersCache: FullFilters | null = null;
  private markFeed: BinanceWsPriceFeed | null = null;

  constructor(opts: BinanceDemoOpts) {
    // defense in depth: refuse a production host even if config were bypassed.
    assertPaper(opts.futuresBase, 'FUTURES_BASE');
    this.opts = opts;
    // real-time mark over WS (public read); getMarkPrice falls back to REST.
    if (opts.markWsBase) {
      this.markFeed = new BinanceWsPriceFeed(opts.symbol, 'markPrice@1s', opts.markWsBase);
      this.markFeed.start();
    }
  }

  hasKeys(): boolean {
    return this.opts.apiKey.length > 0 && this.opts.apiSecret.length > 0;
  }

  // ── request helpers ────────────────────────────────────────────────────────
  private qs(params: Record<string, string | number>): string {
    return Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  }

  private sign(query: string): string {
    return crypto.createHmac('sha256', this.opts.apiSecret).update(query).digest('hex');
  }

  private async publicGet<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
    const url = `${this.opts.futuresBase}${path}${Object.keys(params).length ? '?' + this.qs(params) : ''}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${path} ${res.status}: ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  private async signed<T>(method: 'GET' | 'POST' | 'DELETE', path: string, params: Record<string, string | number> = {}): Promise<T> {
    if (!this.hasKeys()) throw new Error('No API keys configured (.env)');
    const withTime = { ...params, timestamp: Date.now(), recvWindow: 5000 };
    const query = this.qs(withTime);
    const url = `${this.opts.futuresBase}${path}?${query}&signature=${this.sign(query)}`;
    const res = await fetch(url, { method, headers: { 'X-MBX-APIKEY': this.opts.apiKey } });
    if (!res.ok) throw new Error(`${path} ${res.status}: ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  private roundToStep(qty: number, step: number): number {
    return Math.floor(Math.abs(qty) / step) * step * Math.sign(qty);
  }

  // ── ExecutionVenue ─────────────────────────────────────────────────────────
  async getMarkPrice(): Promise<number> {
    const ws = this.markFeed?.latest(); // real-time WS mark if fresh
    if (ws) return ws;
    const r = await this.publicGet<{ markPrice: string }>('/fapi/v1/premiumIndex', { symbol: this.opts.symbol });
    return parseFloat(r.markPrice);
  }

  async getPositionUnits(): Promise<number> {
    const r = await this.signed<any[]>('GET', '/fapi/v2/positionRisk', { symbol: this.opts.symbol });
    const p = Array.isArray(r) ? (r.find((x) => x.symbol === this.opts.symbol) ?? r[0]) : r;
    return p ? parseFloat(p.positionAmt) : 0;
  }

  async getFilters(): Promise<VenueFilters> {
    if (this.filtersCache) return this.filtersCache;
    const info = await this.publicGet<any>('/fapi/v1/exchangeInfo');
    const sym = info.symbols.find((s: any) => s.symbol === this.opts.symbol);
    if (!sym) throw new Error(`symbol ${this.opts.symbol} not found`);
    const lot = sym.filters.find((f: any) => f.filterType === 'LOT_SIZE');
    const notional = sym.filters.find((f: any) => f.filterType === 'MIN_NOTIONAL');
    const priceF = sym.filters.find((f: any) => f.filterType === 'PRICE_FILTER');
    this.filtersCache = {
      stepSize: parseFloat(lot.stepSize),
      minQty: parseFloat(lot.minQty),
      minNotional: parseFloat(notional?.notional ?? notional?.minNotional ?? '5'),
      qtyPrecision: sym.quantityPrecision,
      tickSize: parseFloat(priceF?.tickSize ?? '0.1'),
      pricePrecision: sym.pricePrecision ?? 2,
    };
    return this.filtersCache;
  }

  async marketOrder(side: Side, qty: number, reduceOnly: boolean): Promise<OrderResult> {
    const f = (await this.getFilters()) as FullFilters;
    const q = Math.abs(parseFloat(this.roundToStep(qty, f.stepSize).toFixed(f.qtyPrecision)));
    if (q < f.minQty) return { dryRun: false, side, qty: 0, avgPrice: 0 };

    const raw = await this.signed<{ avgPrice?: string; orderId?: number }>('POST', '/fapi/v1/order', {
      symbol: this.opts.symbol, side, type: 'MARKET', quantity: q, newOrderRespType: 'RESULT',
      ...(reduceOnly ? { reduceOnly: 'true' } : {}),
    });

    // the demo POST omits avgPrice — query the order back for the real fill so the
    // ledger can measure slippage. Best-effort: on failure avgPrice=0 (unmeasured).
    let avgPrice = parseFloat(raw?.avgPrice ?? '0') || 0;
    if (!avgPrice && raw?.orderId) {
      try {
        const q2 = await this.signed<{ avgPrice?: string; cumQuote?: string; executedQty?: string }>('GET', '/fapi/v1/order', {
          symbol: this.opts.symbol, orderId: raw.orderId,
        });
        avgPrice = parseFloat(q2?.avgPrice ?? '0') || 0;
        if (!avgPrice) {
          const cum = parseFloat(q2?.cumQuote ?? '0');
          const ex = parseFloat(q2?.executedQty ?? '0');
          if (cum > 0 && ex > 0) avgPrice = cum / ex;
        }
      } catch {
        /* leave 0 — unmeasured */
      }
    }
    return { dryRun: false, side, qty: q, avgPrice };
  }

  // Post-only maker order. Rests at the near touch (BUY at bid, SELL at ask),
  // waits up to timeoutMs, then CANCELS the remainder and reports only what
  // actually filled. A zero or partial fill is a normal outcome — Hedger
  // completes the rest by crossing, so the hedge is never left unestablished.
  //
  // timeInForce GTX is Binance's post-only ("Good Till Crossing"): the order is
  // REJECTED outright rather than filled if it would cross. That is the point —
  // a maker order that silently crosses pays taker fees while being accounted
  // as maker, which would quietly corrupt the fee comparison this path exists
  // to make.
  async makerOrder(side: Side, qty: number, reduceOnly: boolean, timeoutMs: number): Promise<OrderResult> {
    const f = (await this.getFilters()) as FullFilters;
    const q = Math.abs(parseFloat(this.roundToStep(qty, f.stepSize).toFixed(f.qtyPrecision)));
    if (q < f.minQty) return { dryRun: false, side, qty: 0, avgPrice: 0, maker: true };

    const book = await this.bookTicker();
    const px = side === 'BUY' ? book.bid : book.ask;
    if (!(px > 0)) return { dryRun: false, side, qty: 0, avgPrice: 0, maker: true };
    const price = parseFloat(this.roundToStep(px, f.tickSize).toFixed(f.pricePrecision));

    let orderId: number | undefined;
    try {
      const raw = await this.signed<{ orderId?: number }>('POST', '/fapi/v1/order', {
        symbol: this.opts.symbol, side, type: 'LIMIT', timeInForce: 'GTX',
        quantity: q, price, newOrderRespType: 'RESULT',
        ...(reduceOnly ? { reduceOnly: 'true' } : {}),
      });
      orderId = raw?.orderId;
    } catch (e) {
      // A GTX rejection (the order would have crossed) IS an expected outcome
      // and must not throw. Everything else — precision, auth, bad symbol,
      // connectivity — is a REAL failure and must surface.
      //
      // This previously swallowed every error alike and returned a zero fill,
      // which made a broken order indistinguishable from "nobody hit us". A
      // precision bug in a test harness looked exactly like a 0% fill rate, and
      // in production a misconfigured venue would have looked like a quiet
      // market while the hedge silently never established. Same silent-failure
      // class as the unpaginated Scan and the sign mapping.
      const msg = String(e);
      const isPostOnlyReject = msg.includes('-5022') || /could not be executed as maker/i.test(msg);
      if (isPostOnlyReject) return { dryRun: false, side, qty: 0, avgPrice: 0, maker: true };
      throw e;
    }
    if (!orderId) return { dryRun: false, side, qty: 0, avgPrice: 0, maker: true };

    const deadline = Date.now() + Math.max(0, timeoutMs);
    let executed = 0, avgPrice = 0;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 150));
      try {
        const o = await this.signed<{ status?: string; executedQty?: string; avgPrice?: string }>(
          'GET', '/fapi/v1/order', { symbol: this.opts.symbol, orderId });
        executed = parseFloat(o?.executedQty ?? '0') || 0;
        avgPrice = parseFloat(o?.avgPrice ?? '0') || 0;
        if (o?.status === 'FILLED' || o?.status === 'CANCELED' || o?.status === 'EXPIRED') break;
      } catch { /* transient — keep waiting until the deadline */ }
    }

    // Always attempt the cancel. If it already filled the cancel simply fails,
    // which is harmless; leaving a stale resting order is NOT — it would fill
    // later, unmanaged, against a position the hedger thinks it never took.
    try {
      await this.signed('DELETE', '/fapi/v1/order', { symbol: this.opts.symbol, orderId });
    } catch { /* already filled or gone */ }

    // Re-read once after cancelling: a fill can land between the last poll and
    // the cancel, and missing it would under-report the position.
    try {
      const o = await this.signed<{ executedQty?: string; avgPrice?: string }>(
        'GET', '/fapi/v1/order', { symbol: this.opts.symbol, orderId });
      executed = Math.max(executed, parseFloat(o?.executedQty ?? '0') || 0);
      avgPrice = parseFloat(o?.avgPrice ?? '0') || avgPrice;
    } catch { /* keep the last known values */ }

    return { dryRun: false, side, qty: executed, avgPrice, maker: true };
  }

  private async bookTicker(): Promise<{ bid: number; ask: number }> {
    const r = await this.publicGet<{ bidPrice?: string; askPrice?: string }>(
      '/fapi/v1/ticker/bookTicker', { symbol: this.opts.symbol });
    return { bid: parseFloat(r?.bidPrice ?? '0') || 0, ask: parseFloat(r?.askPrice ?? '0') || 0 };
  }

  async setLeverage(x: number): Promise<void> {
    if (!this.hasKeys()) return;
    await this.signed('POST', '/fapi/v1/leverage', { symbol: this.opts.symbol, leverage: Math.max(1, Math.round(x)) });
  }

  // one-time setup: leverage + multi-assets margin so USDC+USDT both back the hedge.
  async prepare(leverage: number, multiAssets: boolean): Promise<void> {
    if (!this.hasKeys()) return;
    try {
      await this.setLeverage(leverage);
    } catch (e) {
      console.error('[binance-demo] setLeverage failed (open position?):', String(e).slice(0, 80));
    }
    try {
      await this.signed('POST', '/fapi/v1/multiAssetsMargin', { multiAssetsMargin: multiAssets ? 'true' : 'false' });
    } catch (e) {
      console.error('[binance-demo] multiAssetsMargin failed (open position?):', String(e).slice(0, 80));
    }
  }
}
