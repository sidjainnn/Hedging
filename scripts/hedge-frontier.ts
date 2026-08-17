// Hedge-fraction frontier over REAL BTC price paths.
//
// Supersedes the single synthetic Gaussian position used when the fee problem
// was first identified (docs / architecture PDF §8.7). Two things change:
//   1. Terminal moves come from REAL BTC 5-minute returns, not a normal draw —
//      so fat tails and the actual autocorrelation structure are present.
//   2. The hedge P&L is path-independent here (a static hedge held to expiry),
//      which is deliberate: it isolates SIZING from rebalancing policy.
//
// NOT a backtest of actual recorded inventory. data/exposure.csv holds only
// 9 markets with any inventory at all and a median peak of 13 net contracts —
// far too thin to estimate a frontier from, and reporting one from it would be
// false precision. Inventory is therefore parameterised, and the frontier is
// reported as a function of it.
import { empiricalDigital, empiricalProbYes } from '../src/core/empirical.js';
import { readFileSync } from 'node:fs';

const TAKER = 4 / 1e4, MAKER = 2 / 1e4;

function realReturns(path: string, barsPerWindow: number): number[] {
  const lines = readFileSync(path, 'utf8').trim().split('\n');
  const head = lines[0]!.split(',');
  const ci = head.indexOf('close');
  const px = lines.slice(1).map((l) => Number(l.split(',')[ci]!)).filter(Number.isFinite);
  const out: number[] = [];
  for (let i = barsPerWindow; i < px.length; i++) out.push(px[i]! / px[i - barsPerWindow]! - 1);
  return out;
}

const rets = realReturns(
  '/Users/sidharthjain/gb-crypto-kronos/data/btcusdt_1m_train.csv', 5); // 5 x 1m = one window
const S0 = 64000, tau = 300, N = 1786;
const sig = 0.5 / Math.sqrt(365 * 24 * 3600);

// Empirical moments of the real 5-minute return, for comparison with the
// Gaussian the earlier analysis assumed.
const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length);
const kurt = rets.reduce((a, b) => a + ((b - mean) / sd) ** 4, 0) / rets.length;
console.log(`real 5m returns: n=${rets.length}  sd=${(sd * 100).toFixed(3)}% ($${(sd * S0).toFixed(0)})  excess kurtosis=${(kurt - 3).toFixed(1)}`);
console.log(`(a Gaussian has excess kurtosis 0 — the gap is the fat tail the earlier analysis missed)\n`);

for (const off of [0, 10, -10]) {
  const K = S0 - off;             // spot = K + off
  const p0 = empiricalProbYes(S0, K, tau);
  const full = N * empiricalDigital(S0, K, sig, tau).dpdS;
  const pnl = (h: number) => rets.map((r) => {
    const st = S0 * (1 + r);
    return N * p0 - (st >= K ? N : 0) + h * (st - S0);
  });
  const stats = (v: number[]) => {
    const m = v.reduce((a, b) => a + b, 0) / v.length;
    const s = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length);
    const srt = [...v].sort((a, b) => a - b);
    return { m, s, p01: srt[Math.floor(0.01 * srt.length)]!, p05: srt[Math.floor(0.05 * srt.length)]! };
  };
  const base = stats(pnl(0));
  console.log(`=== spot = strike ${off >= 0 ? '+' : ''}${off}   full delta hedge ${full.toFixed(2)} BTC ===`);
  console.log('  frac   hedge BTC    SD    risk removed    1% worst    taker fee   maker fee   net@3c taker');
  for (const f of [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.75, 1.0]) {
    const h = full * f, st = stats(pnl(h));
    const notl = Math.abs(h) * S0, ft = 2 * notl * TAKER, fm = 2 * notl * MAKER;
    const edge = N * 3 / 100;
    console.log(`  ${f.toFixed(2)}  ${h.toFixed(2).padStart(9)}  ${('$' + st.s.toFixed(0)).padStart(6)}  `
      + `${((1 - st.s / base.s) * 100).toFixed(0).padStart(11)}%  ${('$' + st.p01.toFixed(0)).padStart(10)}  `
      + `${('$' + ft.toFixed(0)).padStart(10)}  ${('$' + fm.toFixed(0)).padStart(9)}  ${('$' + (edge - ft).toFixed(0)).padStart(11)}`);
  }
  console.log();
}
