// LIVE post-only fill-rate test on the Binance DEMO venue.
//
// The maker path was justified by an expected-value argument (risk $1.09 of
// exposure to save $3.00 of fee). That argument assumes a fill rate we had not
// measured, and — more importantly — assumes the RISK OF MISSING is symmetric.
// It is not. A resting BID fills when price ticks DOWN and misses when price
// runs UP. If we are buying to hedge, the miss is correlated with exactly the
// move we needed protecting from. This measures both.
//
// Places minimum-size post-only orders on the TESTNET, waits, cancels, and
// records whether it filled and what spot did meanwhile. Nothing here touches
// mainnet — config.ts blocks it at construction.
//
//   npx tsx scripts/maker-fill-test.ts [rounds]
import { BinanceDemoVenue } from '../src/venue/binance-demo.js';
import { config } from '../src/config.js';

const ROUNDS = Number(process.argv[2] ?? 20);
const WAIT_MS = 1500;

async function main() {
  const v = new BinanceDemoVenue({
    symbol: config.symbol,
    futuresBase: config.futuresBase,
    apiKey: config.apiKey,
    apiSecret: config.apiSecret,
    markWsBase: config.futuresWsBase || undefined,
  } as any);
  if (!v.hasKeys()) { console.log('no keys — cannot run live test'); return; }

  const f = await v.getFilters();
  console.log(`venue ${v.name}  ${config.futuresBase}`);
  console.log(`min qty ${f.minQty}  step ${f.stepSize}  min notional $${f.minNotional}\n`);

  const mark0 = await v.getMarkPrice();
  const qty = Math.max(f.minQty, Math.ceil((f.minNotional * 1.1) / mark0 / f.stepSize) * f.stepSize);
  console.log(`test size ${qty} BTC (~$${(qty * mark0).toFixed(0)}), ${WAIT_MS}ms rest, ${ROUNDS} rounds\n`);

  let filled = 0, missed = 0;
  const movesOnFill: number[] = [], movesOnMiss: number[] = [];

  for (let i = 0; i < ROUNDS; i++) {
    // Alternate side so a one-way drift during the test cannot masquerade as a
    // fill-rate result.
    const side = i % 2 === 0 ? 'BUY' : 'SELL';
    const before = await v.getMarkPrice();
    let res;
    try {
      res = await v.makerOrder(side as any, qty, false, WAIT_MS);
    } catch (e) {
      console.log(`  ${i + 1}: ERROR ${String(e).slice(0, 60)}`); continue;
    }
    const after = await v.getMarkPrice();
    // Signed move in the direction that HURTS an unfilled hedge: if we were
    // trying to BUY, a rise hurts (we now must buy higher).
    const adverse = side === 'BUY' ? after - before : before - after;
    const got = res.qty > 0;
    if (got) { filled++; movesOnFill.push(adverse); } else { missed++; movesOnMiss.push(adverse); }
    console.log(`  ${String(i + 1).padStart(2)}: ${side.padEnd(4)} ${got ? `FILLED ${res.qty}` : 'missed'.padEnd(12)}  adverse move $${adverse.toFixed(2)}`);

    // Flatten anything that did fill, so the test leaves no position behind.
    if (got) {
      try { await v.marketOrder(side === 'BUY' ? 'SELL' : 'BUY' as any, res.qty, true); } catch { /* best effort */ }
    }
    await new Promise((r) => setTimeout(r, 400));
  }

  const n = filled + missed;
  const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  console.log(`\nfill rate            ${filled}/${n} = ${n ? (100 * filled / n).toFixed(0) : 0}%`);
  console.log(`avg adverse move, FILLED  $${avg(movesOnFill).toFixed(2)}`);
  console.log(`avg adverse move, MISSED  $${avg(movesOnMiss).toFixed(2)}`);
  console.log(`\nIf 'missed' shows a materially LARGER adverse move than 'filled',`);
  console.log(`the maker path is adversely selected: it misses precisely when the`);
  console.log(`hedge was most needed, and the fee saving is not free.`);

  const pos = await v.getPositionUnits();
  console.log(`\nresidual position after test: ${pos} BTC (should be 0)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
