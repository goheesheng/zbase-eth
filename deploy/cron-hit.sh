#!/usr/bin/env bash
# Host-cron shim: authenticated hit on an app cron route, per network.
# Usage: cron-hit.sh <mainnet|sepolia> <decoy|indexer-sync|asp-update>
# Install examples live in deploy/crontab.example.
set -euo pipefail

# Allowlist BOTH args. Never interpolate arbitrary input into a URL carrying an
# operator bearer, and always select the matching network's loopback port/env.
case "${1:-}" in
  mainnet) port=3000; env=/srv/zbase/mainnet/app.env ;;
  sepolia) port=3100; env=/srv/zbase/sepolia/app.env ;;
  *) echo "usage: cron-hit.sh <mainnet|sepolia> <decoy|indexer-sync|asp-update>" >&2; exit 2 ;;
esac

method=GET
secret_name=CRON_SECRET
case "${2:-}" in
  decoy|indexer-sync) route="api/cron/$2" ;;
  asp-update)
    route="api/asp-update"
    method=POST
    # /api/asp-update prefers its dedicated secret when configured.
    secret_name=ASP_UPDATE_SECRET
    ;;
  *) echo "usage: cron-hit.sh <mainnet|sepolia> <decoy|indexer-sync|asp-update>" >&2; exit 2 ;;
esac

# Read only the required bearer from dotenv; never source the application env.
# ASP_UPDATE_SECRET is optional, so match the route's fallback to CRON_SECRET.
AUTH_SECRET=$(grep -E "^${secret_name}=.+" "$env" | tail -1 | cut -d= -f2- | tr -d '\r' || true)
if [ -z "${AUTH_SECRET:-}" ] && [ "$secret_name" = ASP_UPDATE_SECRET ]; then
  AUTH_SECRET=$(grep -E '^CRON_SECRET=.+' "$env" | tail -1 | cut -d= -f2- | tr -d '\r' || true)
fi
[ -n "${AUTH_SECRET:-}" ] || {
  echo "${secret_name} (or CRON_SECRET fallback) missing in $env" >&2
  exit 1
}

# Jitter prevents cron ticks from forming a precise public timing signature.
sleep $((RANDOM % 45))
exec curl -fsS -m 300 -X "$method" -H "Authorization: Bearer ${AUTH_SECRET}" \
  "http://127.0.0.1:${port}/${route}"
