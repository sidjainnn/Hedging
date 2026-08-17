// Phase 0 feasibility analysis — reads the exposure.csv produced by
// ExposureRecorder (RECORD_EXPOSURE=true) and computes the three
// pre-registered measurements from docs/cross-market-hedging-research-plan.md
// §5 (Phase 0.2-0.4), each against its kill threshold. No modeling, no
// fitting — every number here is a direct query over recorded data.
//
// Usage: npx tsx scripts/phase0-analysis.ts [path/to/exposure.csv]
import { readFileSync } from 'node:fs';
import path from 'node:path';

const csvPath = process.argv[2] ?? path.join(process.env.DATA_DIR ?? 'data', 'exposure.csv');

interface Row {
  ts: number; marketId: string; strike: number; expiryTs: number; tauSec: number;
  spot: number; qYes: number; qNo: number; delta: number; gamma: number;
}

function loadRows(): Row[] {
  const lines = readFileSync(csvPath, 'utf8').trim().split('\n');
  const [header, ...rest] = lines;
  const cols = header.split(',');
  return rest.map((l) => {
    const v = l.split(',');
    const row = {} as Row;
    cols.forEach((c, i) => {
      (row as any)[c] = c === 'marketId' ? v[i] : Number(v[i]);
    });
    return row;
  });
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))));
  return sorted[idx]!;
}

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  if (n < 2) return NaN;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) {
    cov += (a[i]! - ma) * (b[i]! - mb);
    va += (a[i]! - ma) ** 2;
    vb += (b[i]! - mb) ** 2;
  }
  if (va === 0 || vb === 0) return NaN;
  return cov / Math.sqrt(va * vb);
}

const rows = loadRows();
if (rows.length === 0) {
  console.error(`No rows in ${csvPath} — run the service with RECORD_EXPOSURE=true for a live stretch first.`);
  process.exit(1);
}
console.log(`Loaded ${rows.length} rows from ${csvPath}`);

// Group by tick.
const byTick = new Map<number, Row[]>();
for (const r of rows) {
  if (!byTick.has(r.ts)) byTick.set(r.ts, []);
  byTick.get(r.ts)!.push(r);
}
const ticks = [...byTick.keys()].sort((a, b) => a - b);

// ── Realized per-second vol from the recorded spot series (the CSV doesn't
// carry sigmaPerSec — deriving it here from spot avoids re-touching the
// recorder for a Phase-0-only script; same technique as Loop.realizedVol()). ──
const spotSeries = ticks.map((t) => byTick.get(t)![0]!.spot);
function sigmaPerSecAt(i: number, window = 20): number {
  const start = Math.max(1, i - window + 1);
  const rets: number[] = [];
  let dtSum = 0;
  for (let j = start; j <= i; j++) {
    rets.push((spotSeries[j]! - spotSeries[j - 1]!) / spotSeries[j - 1]!);
    dtSum += (ticks[j]! - ticks[j - 1]!) / 1000;
  }
  if (rets.length < 2) return 1e-5; // cold start floor, matches MIN_SIGMA_PER_SEC's role
  const m = rets.reduce((s, x) => s + x, 0) / rets.length;
  const variance = rets.reduce((s, x) => s + (x - m) ** 2, 0) / rets.length;
  const dtMean = Math.max(dtSum / rets.length, 1);
  return Math.sqrt(variance) / Math.sqrt(dtMean);
}

// ═══ Measurement 1 — Gamma concentration: gross Σ|qΓ| vs net |Σ qΓ| per tick ═══
const concRatios: number[] = [];
for (const t of ticks) {
  const mkts = byTick.get(t)!;
  if (mkts.length < 2) continue; // netting is only meaningful with >=2 concurrent markets
  const gross = mkts.reduce((s, m) => s + Math.abs(m.gamma), 0);
  const net = Math.abs(mkts.reduce((s, m) => s + m.gamma, 0));
  if (net > 1e-15) concRatios.push(gross / net);
}
concRatios.sort((a, b) => a - b);
const concP50 = quantile(concRatios, 0.5);
const concP90 = quantile(concRatios, 0.9);
const CONC_KILL = 1.15;

// ═══ Measurement 2 — Hedge availability at high-gamma moments ═══
// Self-calibrating threshold: top decile of the |gamma| distribution actually
// observed, not a fixed constant (per the research doc's stated approach).
const allGammaAbs = rows.map((r) => Math.abs(r.gamma)).sort((a, b) => a - b);
const highGammaThreshold = quantile(allGammaAbs, 0.9);
const BAND_C = 2; // usable-gamma band half-width, in multiples of σ√τ
let highGammaMoments = 0;
let availableStaggered = 0; // similar-tenor candidate available (within 20% of τ)
let availableLadder = 0; // long-tenor candidate available (>3x τ)
for (let i = 0; i < ticks.length; i++) {
  const t = ticks[i]!;
  const mkts = byTick.get(t)!;
  const sigma = sigmaPerSecAt(i);
  for (const m of mkts) {
    if (Math.abs(m.gamma) < highGammaThreshold) continue;
    highGammaMoments++;
    let staggeredHit = false, ladderHit = false;
    for (const other of mkts) {
      if (other.marketId === m.marketId) continue;
      // σ√τ is a FRACTIONAL (log-moneyness) width — must scale by spot to get
      // a dollar band before comparing against a dollar distance. Missing this
      // multiplication silently guaranteed usable===false on every real market
      // (band ~0.001 vs a dollar gap of tens of dollars) — caught by manually
      // checking a tick with genuine cross-tenor inventory rather than trusting
      // a suspiciously clean 0% result.
      const band = BAND_C * sigma * Math.sqrt(Math.max(other.tauSec, 1)) * other.spot;
      const usable = Math.abs(other.spot - other.strike) < band;
      if (!usable) continue;
      const tauRatio = other.tauSec / Math.max(m.tauSec, 1);
      if (tauRatio > 0.8 && tauRatio < 1.25) staggeredHit = true;
      else if (tauRatio > 3) ladderHit = true;
    }
    if (staggeredHit) availableStaggered++;
    if (ladderHit) availableLadder++;
  }
}
const availStaggeredFrac = highGammaMoments ? availableStaggered / highGammaMoments : NaN;
const availLadderFrac = highGammaMoments ? availableLadder / highGammaMoments : NaN;
const AVAIL_KILL = 0.3;

// ═══ Measurement 3 — Flow (inventory-skew) decorrelation across concurrent markets ═══
// Per-market skew series (qYes-qNo) at each tick it appears; pairwise correlate
// the tick-to-tick DELTA of skew for markets that overlap in time.
const skewByMarket = new Map<string, { t: number; skew: number }[]>();
for (const r of rows) {
  if (!skewByMarket.has(r.marketId)) skewByMarket.set(r.marketId, []);
  skewByMarket.get(r.marketId)!.push({ t: r.ts, skew: r.qYes - r.qNo });
}
const marketIds = [...skewByMarket.keys()];
const pairCorrs: number[] = [];
for (let i = 0; i < marketIds.length; i++) {
  for (let j = i + 1; j < marketIds.length; j++) {
    const a = skewByMarket.get(marketIds[i]!)!;
    const b = skewByMarket.get(marketIds[j]!)!;
    const bMap = new Map(b.map((x) => [x.t, x.skew]));
    const alignedA: number[] = [], alignedB: number[] = [];
    for (let k = 1; k < a.length; k++) {
      const prevB = bMap.get(a[k - 1]!.t), curB = bMap.get(a[k]!.t);
      if (prevB === undefined || curB === undefined) continue; // no overlap this step
      alignedA.push(a[k]!.skew - a[k - 1]!.skew);
      alignedB.push(curB - prevB);
    }
    if (alignedA.length >= 5) { // require a minimum overlap to trust the correlation
      const c = pearson(alignedA, alignedB);
      if (Number.isFinite(c)) pairCorrs.push(Math.abs(c));
    }
  }
}
const flowCorrMedian = pairCorrs.length ? quantile([...pairCorrs].sort((a, b) => a - b), 0.5) : NaN;
const FLOW_KILL = 0.8;

// ═══ Report ═══
console.log('\n' + '='.repeat(70));
console.log('PHASE 0 FEASIBILITY — CROSS-MARKET GAMMA HEDGING');
console.log('='.repeat(70));

console.log(`\n[1] Gamma concentration (gross Σ|qΓ| / net |ΣqΓ|), n=${concRatios.length} ticks with >=2 markets`);
console.log(`    p50=${concP50?.toFixed(3)}  p90=${concP90?.toFixed(3)}  kill if p50 < ${CONC_KILL}`);
console.log(`    → ${Number.isFinite(concP50) && concP50 >= CONC_KILL ? 'PASS' : 'FAIL/INSUFFICIENT DATA'}`);

console.log(`\n[2] Hedge availability at high-gamma moments (top-decile |Γ|, threshold=${highGammaThreshold.toExponential(3)})`);
console.log(`    high-gamma moments: ${highGammaMoments}`);
console.log(`    staggered same-tenor available: ${(availStaggeredFrac * 100).toFixed(1)}%  kill if < ${AVAIL_KILL * 100}%`);
console.log(`    long-tenor ladder available:    ${(availLadderFrac * 100).toFixed(1)}%  kill if < ${AVAIL_KILL * 100}%`);
console.log(`    → staggered: ${availStaggeredFrac >= AVAIL_KILL ? 'PASS' : 'FAIL'}  |  ladder: ${availLadderFrac >= AVAIL_KILL ? 'PASS' : 'FAIL'}`);

console.log(`\n[3] Flow decorrelation, median |pairwise correlation| of Δskew, n=${pairCorrs.length} market pairs`);
console.log(`    median=${flowCorrMedian?.toFixed(3)}  kill if > ${FLOW_KILL}`);
console.log(`    → ${Number.isFinite(flowCorrMedian) && flowCorrMedian <= FLOW_KILL ? 'PASS' : 'FAIL/INSUFFICIENT DATA'}`);

console.log('\n' + '='.repeat(70));
const overallGo =
  Number.isFinite(concP50) && concP50 >= CONC_KILL &&
  (availStaggeredFrac >= AVAIL_KILL || availLadderFrac >= AVAIL_KILL) &&
  Number.isFinite(flowCorrMedian) && flowCorrMedian <= FLOW_KILL;
console.log(`GO/NO-GO: ${overallGo ? 'GO — proceed to Phase 1 backtest' : 'NO-GO — see failing measurement(s) above'}`);
console.log('='.repeat(70));
