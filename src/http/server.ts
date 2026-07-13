// Fastify control plane. Phase 0: /health + /state. Later phases add /metrics,
// /config, /kill.
import Fastify from 'fastify';
import type { Loop } from '../loop.js';

export function buildServer(loop: Loop) {
  const app = Fastify({ logger: false });

  app.get('/health', async () => {
    const s = loop.state;
    // healthy once the loop has ticked and (if it has a spot) has no fatal error.
    const ok = s.tick > 0 && s.lastError === null;
    return { ok, tick: s.tick, venue: s.venue, ts: s.ts };
  });

  app.get('/state', async () => loop.state);

  return app;
}
