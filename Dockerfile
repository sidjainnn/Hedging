# Runs the service under tsx (esbuild) — no separate build step, small surface.
FROM node:22-slim

WORKDIR /app

# install prod deps only (tsx is a runtime dep); leverage layer caching
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# app source
COPY tsconfig.json ./
COPY src ./src

# writable ledger dir owned by the non-root user (mount a volume to persist)
RUN mkdir -p /app/data && chown -R node:node /app/data

ENV NODE_ENV=production
EXPOSE 8790

# non-root
USER node

# liveness: the control plane answers /health once the loop has ticked
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8790)+'/health').then(r=>r.json()).then(j=>process.exit(j.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--import", "tsx", "src/index.ts"]
