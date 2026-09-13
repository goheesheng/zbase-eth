# syntax=docker/dockerfile:1
# zBase Next.js app — VPS image. Build/run docs: deploy/README.md.
#
# node:24-slim (Debian, matches CI's Node 24) instead of alpine:
# @envio-dev/hypersync-client ships glibc NAPI binaries; musl builds are the
# classic alpine runtime failure (breaks when /api/withdraw or indexer-sync
# first touches HyperSync, not at build time).

########## deps ##########
FROM node:24-slim AS deps
WORKDIR /app
# Toolchain for native deps (bufferutil etc.) that fall back to node-gyp
# source builds when no prebuilt binary matches the platform (bit us on
# linux/arm64). Deps/builder stages only — the runner stays slim.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
RUN npm ci --no-audit --no-fund

########## build ##########
FROM node:24-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Workspace build order: core first, invoked from the repo root with -p
# (NOT `cd packages/core && tsc` — on clean checkouts that escapes into the
# app tree and fails TS2307; see .vercelignore header for the history).
RUN npx tsc -p packages/core/tsconfig.json

# NEXT_PUBLIC_* are inlined into the client bundle at BUILD time. They are
# public by definition — safe as build args, wired from docker-compose.yml.
ARG NEXT_PUBLIC_NETWORK=sepolia
ARG NEXT_PUBLIC_BASE_SEPOLIA_RPC=
ARG NEXT_PUBLIC_WALLETCONNECT_ID=
# Mainnet contract addresses — read CLIENT-SIDE at build time by contracts.ts
# to build the deposit UI. Public by definition (NEXT_PUBLIC_). Empty on a
# sepolia build (harmless); required on a mainnet build (asserted below).
ARG NEXT_PUBLIC_BASE_MAINNET_RPC=
ARG NEXT_PUBLIC_BASE_MAINNET_ENTRYPOINT=
ARG NEXT_PUBLIC_BASE_MAINNET_POOL=
ARG NEXT_PUBLIC_BASE_MAINNET_WITHDRAWAL_VERIFIER=
ARG NEXT_PUBLIC_BASE_MAINNET_COMMITMENT_VERIFIER=
ARG NEXT_PUBLIC_BASE_MAINNET_POOL_DEPLOY_BLOCK=
# Upstash URL/token as build args (NOT NEXT_PUBLIC_, so NOT inlined into the
# client bundle — they stay server-side). Needed at BUILD time only because
# facilitator-authz.ts throws at module-load on mainnet without them, and
# `next build` loads every route module to collect page data. Runtime still
# reads them from the env file; these just satisfy the build-time guard.
ARG UPSTASH_REDIS_REST_URL=
ARG UPSTASH_REDIS_REST_TOKEN=
ENV NEXT_PUBLIC_NETWORK=$NEXT_PUBLIC_NETWORK \
    NEXT_PUBLIC_BASE_SEPOLIA_RPC=$NEXT_PUBLIC_BASE_SEPOLIA_RPC \
    NEXT_PUBLIC_WALLETCONNECT_ID=$NEXT_PUBLIC_WALLETCONNECT_ID \
    NEXT_PUBLIC_BASE_MAINNET_RPC=$NEXT_PUBLIC_BASE_MAINNET_RPC \
    NEXT_PUBLIC_BASE_MAINNET_ENTRYPOINT=$NEXT_PUBLIC_BASE_MAINNET_ENTRYPOINT \
    NEXT_PUBLIC_BASE_MAINNET_POOL=$NEXT_PUBLIC_BASE_MAINNET_POOL \
    NEXT_PUBLIC_BASE_MAINNET_WITHDRAWAL_VERIFIER=$NEXT_PUBLIC_BASE_MAINNET_WITHDRAWAL_VERIFIER \
    NEXT_PUBLIC_BASE_MAINNET_COMMITMENT_VERIFIER=$NEXT_PUBLIC_BASE_MAINNET_COMMITMENT_VERIFIER \
    NEXT_PUBLIC_BASE_MAINNET_POOL_DEPLOY_BLOCK=$NEXT_PUBLIC_BASE_MAINNET_POOL_DEPLOY_BLOCK \
    UPSTASH_REDIS_REST_URL=$UPSTASH_REDIS_REST_URL \
    UPSTASH_REDIS_REST_TOKEN=$UPSTASH_REDIS_REST_TOKEN \
    NEXT_TELEMETRY_DISABLED=1
# Fail a MAINNET build that has no client-side pool/entrypoint address — else
# the browser deposit UI silently resolves to zero addresses (codex P1).
RUN if [ "$NEXT_PUBLIC_NETWORK" = "mainnet" ]; then \
      test -n "$NEXT_PUBLIC_BASE_MAINNET_ENTRYPOINT" || { echo "FATAL: mainnet build missing NEXT_PUBLIC_BASE_MAINNET_ENTRYPOINT"; exit 1; }; \
      test -n "$NEXT_PUBLIC_BASE_MAINNET_POOL" || { echo "FATAL: mainnet build missing NEXT_PUBLIC_BASE_MAINNET_POOL"; exit 1; }; \
    fi
RUN NODE_OPTIONS=--max-old-space-size=4096 npx next build

# Circuit whitelist sanity check — /api/withdraw and /api/ragequit read these
# from disk at runtime; a wrong .dockerignore pattern reproduces the ENOENT
# outage documented in .vercelignore. Fail the build, not prod.
RUN test -f public/circuits/withdraw/groth16_pkey.zkey \
 && test -f public/circuits/commitment/groth16_pkey.zkey

########## runner ##########
FROM node:24-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1
# /api/health resolves its git SHA from this (containers have no git);
# injected per-build by deploy/deploy.sh.
ARG GIT_COMMIT_SHA=unknown
ENV GIT_COMMIT_SHA=$GIT_COMMIT_SHA

# Standalone output does NOT include public/ or .next/static — copy them
# next to server.js so it serves them itself (no CDN in front here).
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public

USER node
EXPOSE 3000
CMD ["node", "server.js"]
