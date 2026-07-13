// Binance USDⓈ-M DEMO/testnet perp venue. Ported from amm-hedging's binance.ts
// behind the ExecutionVenue interface. Real orders (dry-run is a separate venue),
// but the base URL is re-asserted against the mainnet blocklist so this can only
// ever talk to a demo host.
import crypto from 'node:crypto';
import { assertPaper } from '../config.js';
import type { ExecutionVenue, OrderResult, Side, VenueFilters } from './types.js';

export interface BinanceDemoOpts {
  apiKey: string;
  apiSecret: string;
  futuresBase: string; // e.g. https://demo-fapi.binance.com
  symbol: string;
}

interface FullFilters extends VenueFilters {
  qtyPrecision: number;
}

export class BinanceDemoVenue implements ExecutionVenue {
  readonly name = 'binance-demo';
  private opts: BinanceDemoOpts;
  private filtersCache: FullFilters | null = null;

  constructor(opts: BinanceDemoOpts) {
    // defense in depth: refuse a production host even if config were bypassed.
    assertPaper(opts.futuresBase, 'FUTURES_BASE');
    this.opts = opts;
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
    this.filtersCache = {
      stepSize: parseFloat(lot.stepSize),
      minQty: parseFloat(lot.minQty),
      minNotional: parseFloat(notional?.notional ?? notional?.minNotional ?? '5'),
      qtyPrecision: sym.quantityPrecision,
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
