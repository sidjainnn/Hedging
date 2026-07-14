// Ledger: windows roll on clock boundaries, diffs are correct, and a read-only
// FS degrades to memory-only instead of crashing (the container bug we hit).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServiceLedger } from '../src/core/ledger.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tick = (now: number, hedgePnl: number, over: Record<string, unknown> = {}) => ({
  now, armed: true, notionalUsdt: 1000, realizedVol: 4e-5, position: 0.1,
  cum: { hedgePnl, feesPaid: 0, fillCount: 0, notionalTraded: 0, slippagePaid: 0 },
  ...over,
});

test('windows roll on clock boundary and record a finite hedge P&L diff', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ledger-'));
  const L = new ServiceLedger(1000, dir);
  L.tick(tick(500, 0)); // window 0
  L.tick(tick(600, 3)); // window 0
  L.tick(tick(1500, 5)); // window 1 → closes window 0
  const rows = L.rows();
  assert.ok(rows.length >= 1, 'a window closed');
  const w0 = rows[0]!;
  assert.equal(w0.ticks, 2, 'window 0 saw 2 ticks');
  assert.ok(Number.isFinite(Number(w0.hedge_pnl)), 'hedge_pnl finite');
  assert.equal(Number(w0.hedge_pnl), 5, 'diff = closing cum − opening cum');
});

test('report() summarizes completed windows with finite stats', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ledger-'));
  const L = new ServiceLedger(1000, dir);
  for (let w = 0; w < 5; w++) {
    L.tick(tick(w * 1000 + 100, w * 2));
    L.tick(tick(w * 1000 + 900, w * 2 + 1));
  }
  const r = L.report() as Record<string, number>;
  assert.ok(r.windows >= 4, `expected several windows, got ${r.windows}`);
  assert.ok(Number.isFinite(r.hedge_pnl_mean) && Number.isFinite(r.hedge_pnl_std), 'finite summary stats');
});

test('read-only FS → memory-only, never throws', () => {
  // a path under a file cannot be mkdir'd; the ledger must still run.
  const bogus = path.join(tmpdir(), 'definitely-not-a-dir-' + Math.random(), 'x', 'y');
  let L: ServiceLedger;
  assert.doesNotThrow(() => { L = new ServiceLedger(1000, '/proc/nope-' + Math.random()); });
  const L2 = new ServiceLedger(1000, bogus);
  L2.tick(tick(500, 0));
  L2.tick(tick(1500, 4));
  assert.ok(L2.rows().length >= 1, 'windows still recorded in memory without disk');
});
