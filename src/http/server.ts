// Fastify control plane.
//   GET  /health   liveness
//   GET  /state    full snapshot
//   GET  /metrics  Prometheus exposition
//   POST /config   runtime gate tuning + enable/disable (no redeploy)
//   POST /kill     flatten position + disable the hedge
import Fastify from 'fastify';
import type { Loop } from '../loop.js';
import type { Gate, GateOpts } from '../core/gate.js';
import type { Hedger } from '../core/hedger.js';
import type { ExecutionVenue } from '../venue/types.js';

export interface ControlDeps {
  loop: Loop;
  gate: Gate;
  hedger: Hedger;
  venue: ExecutionVenue;
}

// best mark available: last loop spot, else the venue mark.
async function currentMark(deps: ControlDeps): Promise<number> {
  if (deps.loop.state.spot && deps.loop.state.spot > 0) return deps.loop.state.spot;
  try {
    return await deps.venue.getMarkPrice();
  } catch {
    return 0;
  }
}

function metrics(loop: Loop): string {
  const s = loop.state;
  const g = s.gate;
  const lines: string[] = [];
  const m = (name: string, help: string, val: number) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name} ${Number.isFinite(val) ? val : 0}`);
  };
  m('hedging_up', 'service liveness', 1);
  m('hedging_tick', 'loop tick counter', s.tick);
  m('hedging_spot', 'underlying spot', s.spot ?? 0);
  m('hedging_sigma_per_sec', 'per-second vol used for delta', s.sigmaPerSec);
  m('hedging_aggregate_delta', 'net BTC-equivalent exposure', s.inventory?.aggregateDelta ?? 0);
  m('hedging_notional_usdt', 'exposure notional USDT', s.inventory?.notionalUsdt ?? 0);
  m('hedging_markets', 'hedgeable markets', s.inventory?.markets.length ?? 0);
  m('hedging_markets_skipped', 'markets skipped (meta/feed/expiry)', s.inventory?.skipped ?? 0);
  m('hedging_gate_armed', 'gate armed (1/0)', g?.armed ? 1 : 0);
  m('hedging_vol_gate_on', 'vol gate open (1/0)', g?.volGateOn ? 1 : 0);
  m('hedging_inv_gate_on', 'inventory gate open (1/0)', g?.invGateOn ? 1 : 0);
  m('hedging_effective_gate', 'current inventory gate USDT', g?.effectiveGate ?? 0);
  m('hedging_realized_vol', 'realized per-tick vol', g?.realizedVol ?? 0);
  m('hedging_enabled', 'hedge enabled (1/0)', s.hedger.enabled ? 1 : 0);
  m('hedging_position_units', 'live hedge position BTC', s.hedger.livePosition);
  m('hedging_hedge_pnl', 'hedge P&L USDT', s.hedger.hedgePnl);
  m('hedging_fees_paid', 'cumulative est fees USDT', s.hedger.feesPaid);
  m('hedging_fill_count', 'cumulative fills', s.hedger.fillCount);
  m('hedging_has_error', 'hedger error present (1/0)', s.hedger.lastError ? 1 : 0);
  return lines.join('\n') + '\n';
}

export function buildServer(deps: ControlDeps) {
  const { loop, gate, hedger } = deps;
  const app = Fastify({ logger: false });

  app.get('/health', async () => {
    const s = loop.state;
    return { ok: s.tick > 0 && s.lastError === null, tick: s.tick, venue: s.venue, ts: s.ts };
  });

  app.get('/state', async () => loop.state);

  app.get('/metrics', async (_req, reply) => {
    reply.header('Content-Type', 'text/plain; version=0.0.4');
    return metrics(loop);
  });

  // runtime gate tuning + enable/disable. Body: { enabled?, gate?: {volGate, volThreshold,
  // volHysteresis, mode, notionalFloor, pctl} }
  app.post('/config', async (req) => {
    const body = (req.body ?? {}) as { enabled?: boolean; gate?: Partial<GateOpts> };
    const applied: Record<string, unknown> = {};
    if (typeof body.enabled === 'boolean') {
      hedger.setEnabled(body.enabled);
      applied.enabled = body.enabled;
    }
    if (body.gate && typeof body.gate === 'object') {
      gate.setOpts(body.gate);
      applied.gate = body.gate;
    }
    return { ok: true, applied };
  });

  // kill switch: flatten to zero + disable. Idempotent.
  app.post('/kill', async () => {
    const mark = await currentMark(deps);
    hedger.setEnabled(false);
    let flattened = false;
    if (mark > 0) {
      await hedger.flatten(mark);
      flattened = true;
    }
    return { ok: true, flattened, position: hedger.livePosition, mark, enabled: hedger.enabled };
  });

  return app;
}
