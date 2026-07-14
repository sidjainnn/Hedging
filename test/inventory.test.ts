// Adversarial tests for GamebullInventorySource — the read path from house
// inventory to hedge target. Covers the two things that must never be wrong:
//   1. SIGN — the hedge must OFFSET house exposure, not double it.
//   2. SCALE/SAFETY — no KEYS scan, malformed data skipped, aggregate stays finite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GamebullInventorySource } from '../src/inventory/gamebull.ts';
import type { RedisLike } from '../src/inventory/types.ts';

const NOW = 1_000_000_000_000;
const META = (o: Record<string, unknown>) => JSON.stringify({ underlyingSymbol: 'BTCUSDT', strike: 63000, expiryTs: NOW + 300_000, feedId: 3, ...o });

// in-memory stub. Records smembers calls; has NO keys() method (KEYS at scale
// blocks Redis — the interface forbidding it is the guarantee).
function stub(store: Record<string, string>, active: string[]) {
  const calls = { smembers: 0, get: 0 };
  const redis: RedisLike = {
    get: async (k) => { calls.get++; return store[k] ?? null; },
    smembers: async (k) => { calls.smembers++; return k === 'predictor_active_markets' ? active : []; },
  };
  return { redis, calls };
}

const src = (redis: RedisLike) => new GamebullInventorySource(redis, {
  symbol: 'BTCUSDT', hedgeableFeedIds: [3], activeMarketsKey: 'predictor_active_markets',
  keyYes: 'Y_', keyNo: 'N_', keyMeta: 'M_',
});

test('SIGN: house short YES (qYes>qNo) → positive δ → hedger goes LONG (offsets)', async () => {
  // house sold YES to users ⇒ loses when spot rises ⇒ must hold LONG BTC.
  const { redis } = stub({ Y_m: '5000', N_m: '0', M_m: META({}) }, ['m']);
  const inv = await src(redis).poll(63000, 4e-5, NOW);
  assert.ok(inv.aggregateDelta > 0, `expected LONG (δ>0), got ${inv.aggregateDelta}`);
});

test('SIGN: house short NO (qNo>qYes) → negative δ → hedger goes SHORT (offsets)', async () => {
  const { redis } = stub({ Y_m: '0', N_m: '5000', M_m: META({}) }, ['m']);
  const inv = await src(redis).poll(63000, 4e-5, NOW);
  assert.ok(inv.aggregateDelta < 0, `expected SHORT (δ<0), got ${inv.aggregateDelta}`);
});

test('NETTING: opposite exposures across markets cancel', async () => {
  const { redis } = stub({
    Y_a: '5000', N_a: '0', M_a: META({ strike: 63000 }),
    Y_b: '0', N_b: '5000', M_b: META({ strike: 63000 }),
  }, ['a', 'b']);
  const inv = await src(redis).poll(63000, 4e-5, NOW);
  assert.ok(Math.abs(inv.aggregateDelta) < 1e-9, `should net to ~0, got ${inv.aggregateDelta}`);
  assert.equal(inv.markets.length, 2);
});

test('SAFETY: malformed meta / quantities are skipped, never throw, aggregate finite', async () => {
  const { redis } = stub({
    Y_bad1: 'not-a-number', N_bad1: '10', M_bad1: META({}),
    Y_bad2: 'Infinity', N_bad2: '0', M_bad2: META({}),
    Y_bad3: '100', N_bad3: '0', M_bad3: '{broken json',
    Y_bad4: '100', N_bad4: '0', M_bad4: JSON.stringify({ underlyingSymbol: 'BTCUSDT' }), // missing strike/expiry
    Y_ok: '1000', N_ok: '0', M_ok: META({}),
  }, ['bad1', 'bad2', 'bad3', 'bad4', 'ok']);
  const inv = await src(redis).poll(63000, 4e-5, NOW);
  assert.ok(Number.isFinite(inv.aggregateDelta), `aggregate must be finite, got ${inv.aggregateDelta}`);
  assert.ok(Number.isFinite(inv.notionalUsdt), `notional must be finite, got ${inv.notionalUsdt}`);
  // bad3 (broken JSON) + bad4 (missing fields) are skipped; bad1/bad2 contribute finite/0.
  assert.ok(inv.skipped >= 2, `expected ≥2 skipped, got ${inv.skipped}`);
});

test('FILTER: wrong feed, wrong symbol, and expired markets are skipped', async () => {
  const { redis } = stub({
    Y_sports: '999', N_sports: '0', M_sports: META({ feedId: 1 }),
    Y_eth: '999', N_eth: '0', M_eth: META({ underlyingSymbol: 'ETHUSDT' }),
    Y_expired: '999', N_expired: '0', M_expired: META({ expiryTs: NOW - 1 }),
    Y_live: '1000', N_live: '0', M_live: META({}),
  }, ['sports', 'eth', 'expired', 'live']);
  const inv = await src(redis).poll(63000, 4e-5, NOW);
  assert.equal(inv.markets.length, 1, 'only the live BTC feed-3 market hedged');
  assert.equal(inv.markets[0]!.marketId, 'live');
  assert.equal(inv.skipped, 3);
});

test('SCALE: 10k active markets — completes, uses smembers (no KEYS), aggregate finite', async () => {
  const store: Record<string, string> = {};
  const active: string[] = [];
  for (let i = 0; i < 10_000; i++) {
    active.push('m' + i);
    store['Y_m' + i] = String(50 + (i % 100));
    store['N_m' + i] = String(i % 50);
    store['M_m' + i] = META({ strike: 62000 + (i % 2000) });
  }
  const { redis, calls } = stub(store, active);
  const inv = await src(redis).poll(63000, 4e-5, NOW);
  assert.equal(calls.smembers, 1, 'exactly one active-set read (not a per-key scan)');
  assert.ok(Number.isFinite(inv.aggregateDelta), 'aggregate finite at scale');
  assert.equal(inv.markets.length, 10_000);
});
