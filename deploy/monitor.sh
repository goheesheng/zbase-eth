#!/usr/bin/env bash
# On-box health monitor — run every 5 min via cron (deploy/crontab.example).
#
# Log-only (user choice 2026-07-12): writes PASS/FAIL lines to
# /srv/zbase/monitor.log. Cannot report total box death (an external uptime
# check is the mainnet complement). To add push alerts later, set ALERT_WEBHOOK
# in /srv/zbase/.env and uncomment the curl at the bottom.
#
# Checks: app health "ok", all expected containers up, disk headroom, TLS
# cert days-to-expiry for zbase.app + x402.zbase.app.
set -uo pipefail

APP_DIR=/srv/zbase/app
ENV_FILE=/srv/zbase/.env
LOG=/srv/zbase/monitor.log
DISK_WARN=85          # percent
CERT_WARN_DAYS=20
COMPOSE="sudo docker compose --env-file $ENV_FILE"

ts() { date -u +%FT%TZ; }
fails=()

# 1. App health payload says ok
health=$(curl -fsS -m 10 http://127.0.0.1:3000/api/health 2>/dev/null || echo "")
echo "$health" | grep -q '"status":"ok"' || fails+=("app-health:${health:-unreachable}")

# 2. Expected containers running
for svc in app x402 caddy redis srh; do
  st=$(cd "$APP_DIR" && $COMPOSE ps "$svc" --format '{{.State}}' 2>/dev/null | head -1)
  [ "$st" = "running" ] || fails+=("container-$svc:${st:-missing}")
done

# 3. Disk headroom
use=$(df -P / | awk 'NR==2{gsub(/%/,"",$5); print $5}')
[ "${use:-100}" -lt "$DISK_WARN" ] || fails+=("disk:${use}%")

# 4. TLS expiry (days) for each public host
for host in zbase.app x402.zbase.app; do
  end=$(echo | openssl s_client -servername "$host" -connect 127.0.0.1:443 2>/dev/null \
        | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
  if [ -n "$end" ]; then
    days=$(( ( $(date -d "$end" +%s) - $(date +%s) ) / 86400 ))
    [ "$days" -ge "$CERT_WARN_DAYS" ] || fails+=("cert-$host:${days}d")
  else
    fails+=("cert-$host:unreadable")
  fi
done

if [ ${#fails[@]} -eq 0 ]; then
  echo "$(ts) PASS all checks" >> "$LOG"
else
  msg="$(ts) FAIL ${fails[*]}"
  echo "$msg" >> "$LOG"
  # Push alert (opt-in): set ALERT_WEBHOOK in $ENV_FILE, then uncomment:
  # hook=$(grep -E '^ALERT_WEBHOOK=' "$ENV_FILE" | head -1 | cut -d= -f2-)
  # [ -n "${hook:-}" ] && curl -fsS -m 10 -X POST "$hook" \
  #   -H 'content-type: application/json' \
  #   -d "{\"text\":\"zBase VPS: $msg\"}" >/dev/null 2>&1 || true
  exit 1
fi
