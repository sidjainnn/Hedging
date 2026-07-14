// Deterministic smoke test of the full Phase-0 wiring with an in-memory Redis
// stub and a fixed vol — no infra, no live feed. Proves:
//   GamebullInventorySource → Gate → Hedger → DryRunVenue (intended order).
//   run: npm run selftest
import { GamebullInventorySource } from './inventory/gamebull.js';
import type { RedisLike } from './inventory/types.js';
import { Gate } from './core/gate.js';
import { Hedger } from './core/hedger.js';
import { DryRunVenue } from './venue/dry-run.js';

const now = Date.now();
const store: Record<string, string> = {
  'predictor_active_markets': '', // set membership handled by the stub below
  'MMP_LMSR_QUANTITY_YES_m1': '0',
  'MMP_LMSR_QUANTITY_NO_m1': '5000', // house short YES 5000 (took the other side of user YES flow)
  'MMP_MARKET_META_m1': JSON.stringify({ underlyingSymbol: 'BTCUSDT', strike: 63000, expiryTs: now + 300_000, feedId: 3 }),
  // a sports market that must be skipped (wrong feed)
  'MMP_LMSR_QUANTITY_YES_s9': '100',
  'MMP_MARKET_META_s9': JSON.stringify({ underlyingSymbol: 'BTCUSDT', strike: 1, expiryTs: now + 300_000, feedId: 1 }),
};
const activeMarkets = ['m1', 's9'];
const redis: RedisLike = {
  get: async (k) => store[k] ?? null,
  smembers: async (k) => (k === 'predictor_active_markets' ? activeMarkets : []),
};

const SPOT = 63000;
const SIGMA_PER_SEC = 0.0004;

async function main() {
  const inv = new GamebullInventorySource(redis, {
    symbol: 'BTCUSDT', hedgeableFeedIds: [3], activeMarketsKey: 'predictor_active_markets',
    keyYes: 'MMP_LMSR_QUANTITY_YES_', keyNo: 'MMP_LMSR_QUANTITY_NO_', keyMeta: 'MMP_MARKET_META_',
  });
  const agg = await inv.poll(SPOT, SIGMA_PER_SEC, now);
  console.log('inventory:', JSON.stringify(agg, null, 1));
  console.assert(agg.markets.length === 1, 'expected 1 hedgeable market (feed-3 only)');
  console.assert(agg.skipped === 1, 'expected 1 skipped (sports feed-1)');

  const gate = new Gate({ volGate: false, volThreshold: 0.0002, volHysteresis: 0.6, mode: 'fixed', notionalFloor: 80, pctl: 0.6 });
  const g = gate.update(SIGMA_PER_SEC, agg.notionalUsdt, /* hedgeEnabled */ true);
  console.log('gate:', JSON.stringify(g));
  console.assert(g.armed, 'gate should arm (notional ≫ floor, hedge enabled)');

  const venue = new DryRunVenue();
  venue.setMark(SPOT);
  const hedger = new Hedger(venue, { maxNotionalUsdt: 10_000, deadbandUsdt: 75 }, true);
  const target = g.armed ? agg.aggregateDelta : 0;
  await hedger.reconcile(target, SPOT);
  console.log('hedge action:', JSON.stringify(hedger.log[0]));
  console.log('live position:', hedger.livePosition.toFixed(4), 'BTC  (notional $' + (Math.abs(hedger.livePosition) * SPOT).toFixed(0) + ')');
  console.assert(hedger.log.length > 0 && hedger.log[0]!.order !== null, 'a dry-run order should have fired');
  console.assert(hedger.livePosition < 0, 'house short YES ⇒ hedge SHORT BTC (position < 0)');

  console.log('\n✅ selftest passed — inventory→gate→hedger→venue wired end-to-end');
}
main().catch((e) => { console.error('❌ selftest failed:', e); process.exit(1); });
