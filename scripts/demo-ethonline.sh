#!/usr/bin/env bash
# demo-ethonline.sh — one-command local demo stack for the ETHOnline 2026 video.
#
#   bash scripts/demo-ethonline.sh base   # Base Sepolia: full private x402 agent flow
#   npm run test:x402-agent               #   ...then run the agent in a second terminal
#   bash scripts/demo-ethonline.sh eth    # Ethereum Sepolia: read path against 0xbow's L1 pool
#   bash scripts/demo-ethonline.sh stop   # kill everything it started
#
# What `base` starts (all local, nothing external besides the chain + Envio HyperSync):
#   :4090  dev-hypersync-shim  (eth_getLogs → native HyperSync; *.rpc.hypersync.xyz is 403 for our token)
#   :4091  dev-upstash-shim    (in-memory Upstash-REST store for the shared indexer / locks / rate limit)
#   :3009  zBase facilitator   (Next.js dev, NEXT_PUBLIC_NETWORK=sepolia = Base Sepolia)
#   :4020  x402 test seller    (returns 402, then data once paid)
# then warms the indexer (/api/cron/indexer-sync) and refreshes the ASP root (/api/asp-update).
#
# Next.js allows ONE dev server per project dir, so `base` and `eth` are exclusive; each
# stops the other's dev server first. Secrets are read from .env.local (last line wins,
# same as Next) and never printed.
set -euo pipefail
cd "$(dirname "$0")/.."
LOGS=/tmp/zbase-demo
mkdir -p "$LOGS"

envval() { grep -E "^$1=" .env.local | tail -1 | cut -d= -f2- | tr -d '"' ; }
wait_ready() { # $1 = log file, $2 = label
  for _ in $(seq 1 60); do
    if grep -q "Another next dev server is already running" "$1"; then
      echo "!! $2: another next dev server is running — run: bash scripts/demo-ethonline.sh stop"; exit 1
    fi
    grep -q "Ready" "$1" && return 0
    sleep 1
  done
  echo "!! $2 did not become ready; see $1"; exit 1
}
stop_all() {
  pkill -f "next dev" 2>/dev/null || true
  pkill -f "dev-hypersync-shim" 2>/dev/null || true
  pkill -f "dev-upstash-shim" 2>/dev/null || true
  pkill -f "x402-test-server" 2>/dev/null || true
  sleep 1
}

case "${1:-}" in
  base)
    stop_all
    echo "▶ starting shims"
    (nohup npx tsx scripts/dev-hypersync-shim.ts --network base-sepolia --rpc https://sepolia.base.org --port 4090 > "$LOGS/hypersync-shim.log" 2>&1 &)
    (nohup npx tsx scripts/dev-upstash-shim.ts --port 4091 > "$LOGS/upstash-shim.log" 2>&1 &)
    sleep 3
    echo "▶ starting zBase facilitator on :3009 (Base Sepolia)"
    (HYPERSYNC_URL=http://127.0.0.1:4090 UPSTASH_REDIS_REST_URL=http://127.0.0.1:4091 UPSTASH_REDIS_REST_TOKEN=dev \
      nohup npm run dev -- -p 3009 > "$LOGS/facilitator.log" 2>&1 &)
    wait_ready "$LOGS/facilitator.log" "facilitator"
    echo "▶ warming the shared indexer"
    curl -s -m 300 -X POST -H "Authorization: Bearer $(envval CRON_SECRET)" http://localhost:3009/api/cron/indexer-sync \
      | python3 -c 'import sys,json; d=json.load(sys.stdin); print("   indexer:", d.get("leafCount"), "leaves @ block", d.get("cursor")) if d.get("ok") else print("   indexer:", d)'
    echo "▶ refreshing the ASP root (OFAC screening → updateRoot if changed)"
    curl -s -m 600 -X POST -H "Authorization: Bearer $(envval ASP_UPDATE_SECRET)" http://localhost:3009/api/asp-update \
      | python3 -c 'import sys,json; d=json.load(sys.stdin); print("   asp:", d.get("status"), "| screened", d.get("screened"), "approved", d.get("approved"), "| updated:", d.get("updated"))'
    echo "▶ starting x402 test seller on :4020"
    (nohup npx tsx scripts/x402-test-server.ts > "$LOGS/seller.log" 2>&1 &)
    sleep 2
    echo "▶ facilitator readiness"
    curl -s -m 120 http://localhost:3009/api/facilitator/supported \
      | python3 -c 'import sys,json; d=json.load(sys.stdin); print("   status:", d.get("status"), "| verificationReady:", d.get("verificationReady"), "| pilotReady:", d.get("pilotReady")); print("   indexer:", d.get("privacy",{}).get("indexer"))'
    echo
    echo "READY. In another terminal run:   npm run test:x402-agent"
    echo "Logs: $LOGS/{facilitator,seller,hypersync-shim,upstash-shim}.log"
    ;;
  eth)
    pkill -f "next dev" 2>/dev/null || true
    pkill -f "dev-hypersync-shim.ts --network sepolia" 2>/dev/null || true
    sleep 1
    echo "▶ starting HyperSync shim for Ethereum Sepolia on :4092"
    (nohup npx tsx scripts/dev-hypersync-shim.ts --network sepolia --rpc https://ethereum-sepolia-rpc.publicnode.com --port 4092 > "$LOGS/hypersync-shim-eth.log" 2>&1 &)
    sleep 3
    echo "▶ starting zBase on :3011 (NEXT_PUBLIC_NETWORK=eth-sepolia → 0xbow's Ethereum Sepolia pool)"
    (NEXT_PUBLIC_NETWORK=eth-sepolia HYPERSYNC_URL=http://127.0.0.1:4092 \
      nohup npm run dev -- -p 3011 > "$LOGS/facilitator-eth.log" 2>&1 &)
    wait_ready "$LOGS/facilitator-eth.log" "facilitator (eth-sepolia)"
    echo
    echo "READY. Try:"
    echo "  curl -s localhost:3011/api/facilitator/supported | jq '{contracts, anonymitySet: .privacy.anonymitySet, aspRoot: .privacy.latestAspRoot, pricing: .pricing.networks[\"eip155:11155111\"]}'"
    echo "  curl -s localhost:3011/api/deposits/events | jq '{network, pool, count, leaves: (.leaves|length), withdrawals: (.withdrawals|length)}'"
    echo "  curl -s -X POST localhost:3011/api/withdraw -H 'content-type: application/json' -d '{}'   # → 501 with the explicit reason"
    ;;
  stop)
    stop_all
    echo "stopped"
    ;;
  *)
    echo "usage: $0 base|eth|stop"; exit 1
    ;;
esac
