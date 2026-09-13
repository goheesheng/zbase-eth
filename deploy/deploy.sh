#!/usr/bin/env bash
# zBase VPS deploy — run from the laptop. Network-parameterized.
#
#   ./deploy/deploy.sh sepolia          # deploy the testnet project
#   ./deploy/deploy.sh mainnet          # deploy the mainnet project
#   ./deploy/deploy.sh edge             # deploy/reload the shared Caddy
#   ./deploy/deploy.sh <net> --allow-dirty
#
# Ships the WORKING TREE, builds images ON the box, reconciles ONLY the named
# project's stack, and verifies. Each network is an independent Compose project
# (zbase-<net>) mounting only /srv/zbase/<net>/*.env — a sepolia deploy can
# never touch mainnet containers or read a mainnet secret.
#
# One-time server prep first: deploy/README.md.
set -euo pipefail

NETWORK="${1:-}"
case "$NETWORK" in
  mainnet|sepolia|edge) ;;
  *) echo "usage: deploy.sh <mainnet|sepolia|edge> [--allow-dirty]" >&2; exit 2 ;;
esac
ALLOW_DIRTY=0
[ "${2:-}" = "--allow-dirty" ] && ALLOW_DIRTY=1

VPS="${ZBASE_VPS:-ubuntu@43.156.119.46}"
APP_DIR=/srv/zbase/app
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Per-network wiring.
case "$NETWORK" in
  mainnet)
    COMPOSE=docker-compose.mainnet.yml
    ENV_APP=/srv/zbase/mainnet/app.env
    HEALTH_CONTAINER=mainnet-app
    LOOPBACK=3000
    APP_HOST="${ZBASE_APP_HOST:-mainnet-staging.zbase.app}"  # apex only after cutover
    PAY_HOST="${ZBASE_PAY_HOST:-x402.zbase.app}"
    ;;
  sepolia)
    COMPOSE=docker-compose.sepolia.yml
    ENV_APP=/srv/zbase/sepolia/app.env
    HEALTH_CONTAINER=sepolia-app
    LOOPBACK=3100
    APP_HOST="${ZBASE_APP_HOST:-testnet.zbase.app}"
    PAY_HOST="${ZBASE_PAY_HOST:-x402-testnet.zbase.app}"
    ;;
esac

# SHA of what we're shipping; mark dirty trees so verify output tells the truth.
SHA="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
DIRTY=0
if ! git -C "$REPO_ROOT" diff --quiet || ! git -C "$REPO_ROOT" diff --cached --quiet; then
  DIRTY=1; SHA="${SHA}-dirty"
fi
if [ "$DIRTY" = 1 ] && [ "$ALLOW_DIRTY" = 0 ]; then
  echo "ERROR: working tree is dirty. Commit, or re-run with --allow-dirty." >&2
  git -C "$REPO_ROOT" status --short >&2
  exit 1
fi

echo "==> [$NETWORK] shipping $SHA (full: $(git -C "$REPO_ROOT" rev-parse HEAD)${DIRTY:+ +uncommitted})"

# One rsync of the shared working tree (network-independent). Secrets stay off
# the box (.env* excluded); env files live out-of-band under /srv/zbase/<net>/.
echo "==> rsync working tree -> $VPS:$APP_DIR"
rsync -az --delete \
  --filter=':- .gitignore' \
  --exclude='.git' --exclude='.env*' \
  --exclude='packages/svm' --exclude='packages/mcp' \
  --exclude='deck-export-canva' --exclude='deck-export-large' \
  --exclude='x402-server/logs' \
  "$REPO_ROOT"/ "$VPS:$APP_DIR"/

# Ensure the external edge network exists (idempotent).
ssh "$VPS" 'docker network inspect zbase-web >/dev/null 2>&1 || docker network create zbase-web'

if [ "$NETWORK" = "edge" ]; then
  echo "==> [edge] up/reload shared Caddy"
  ssh "$VPS" "cd $APP_DIR && docker compose -p zbase-edge -f docker-compose.edge.yml up -d && \
    (docker compose -p zbase-edge exec -T caddy caddy reload --config /etc/caddy/Caddyfile 2>/dev/null || \
     docker compose -p zbase-edge restart caddy)"
  echo "==> edge reloaded"
  exit 0
fi

# x402 image is network-agnostic (runtime X402_NETWORK) — build once, shared.
# app image bakes NEXT_PUBLIC_NETWORK at build time — per-network tag.
echo "==> build (sequential — 8GB box) + up project zbase-$NETWORK"
ssh "$VPS" "set -euo pipefail
  cd $APP_DIR
  export GIT_COMMIT_SHA='$SHA'
  docker compose -p zbase-$NETWORK -f $COMPOSE --env-file $ENV_APP build x402
  docker compose -p zbase-$NETWORK -f $COMPOSE --env-file $ENV_APP build app
  docker compose -p zbase-$NETWORK -f $COMPOSE --env-file $ENV_APP up -d --remove-orphans
  docker image prune -f >/dev/null
"

echo "==> waiting for $HEALTH_CONTAINER health"
ssh "$VPS" "
  for i in \$(seq 1 30); do
    s=\$(docker inspect -f '{{.State.Health.Status}}' $HEALTH_CONTAINER 2>/dev/null || echo starting)
    [ \"\$s\" = healthy ] && exit 0
    sleep 5
  done
  echo '$HEALTH_CONTAINER not healthy after 150s; logs:' >&2
  docker logs --tail 40 $HEALTH_CONTAINER >&2 || true
  exit 1
"

echo "==> health payload (on-box, :$LOOPBACK)"
ssh "$VPS" "curl -fsS http://127.0.0.1:$LOOPBACK/api/health | head -c 400; echo"

echo "==> public endpoints"
if curl -fsS --max-time 15 "https://$APP_HOST/api/health" 2>/dev/null | grep -q "${SHA:0:7}"; then
  echo "app:  https://$APP_HOST deployed at $SHA"
else
  echo "WARN: https://$APP_HOST health does not report $SHA (DNS/TLS not live yet, or stale)"
fi
if curl -fsS --max-time 15 "https://$PAY_HOST/health" >/dev/null 2>&1; then
  echo "x402: https://$PAY_HOST OK"
else
  echo "WARN: https://$PAY_HOST/health unreachable (DNS/TLS not live yet?)"
fi
