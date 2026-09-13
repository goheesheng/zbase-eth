#!/usr/bin/env bash
# Encrypted Redis snapshot — run daily via cron (deploy/crontab.example).
#
# Redis already persists AOF+RDB in the redis_data volume, but that dies WITH
# the disk. This takes a point-in-time BGSAVE, encrypts it at rest with the
# same key class as seed data, and keeps a rolling set on-box in a SEPARATE
# directory. On-box copies survive container/redis loss but NOT box/disk loss —
# fill in the OFF-BOX HOOK below before mainnet (that's the P1).
#
# Restore: openssl enc -d -aes-256-cbc -pbkdf2 -pass file:<keyfile> \
#            -in dump-<ts>.rdb.enc -out dump.rdb, then load into a fresh redis.
set -euo pipefail

APP_DIR=/srv/zbase/app
ENV_FILE=/srv/zbase/.env
BACKUP_DIR=/srv/zbase/backups
KEEP=14
COMPOSE="sudo docker compose --env-file $ENV_FILE"

mkdir -p "$BACKUP_DIR"
cd "$APP_DIR"

# Encryption key: reuse ZBASE_SEED_ENCRYPTION_KEY (already a vaulted secret).
# Read it without sourcing the whole env file. Take the LAST non-empty match —
# compose/dotenv both use last-wins, and the box env has a known empty earlier
# duplicate of this var (grab the real value, not the blank one).
KEY=$(grep -E '^ZBASE_SEED_ENCRYPTION_KEY=.+' "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '\r')
[ -n "${KEY:-}" ] || { echo "$(date -u +%FT%TZ) backup FAIL: ZBASE_SEED_ENCRYPTION_KEY missing" >&2; exit 1; }
KEYFILE=$(mktemp); printf '%s' "$KEY" > "$KEYFILE"; trap 'rm -f "$KEYFILE"' EXIT

TS=$(date -u +%Y%m%dT%H%M%SZ)
OUT="$BACKUP_DIR/dump-$TS.rdb.enc"

# Trigger a fresh save and wait for it to land (lastsave timestamp bumps).
BEFORE=$($COMPOSE exec -T redis redis-cli LASTSAVE | tr -d '\r')
$COMPOSE exec -T redis redis-cli BGSAVE >/dev/null
for _ in $(seq 1 30); do
  AFTER=$($COMPOSE exec -T redis redis-cli LASTSAVE | tr -d '\r')
  [ "$AFTER" != "$BEFORE" ] && break
  sleep 1
done

# Stream the RDB out of the volume and encrypt in one pipe (no plaintext at rest).
$COMPOSE exec -T redis cat /data/dump.rdb \
  | openssl enc -aes-256-cbc -pbkdf2 -salt -pass "file:$KEYFILE" -out "$OUT"
SIZE=$(stat -c%s "$OUT" 2>/dev/null || echo 0)
[ "$SIZE" -gt 0 ] || { echo "$(date -u +%FT%TZ) backup FAIL: empty snapshot" >&2; exit 1; }

# Rolling retention.
ls -1t "$BACKUP_DIR"/dump-*.rdb.enc 2>/dev/null | tail -n +$((KEEP+1)) | xargs -r rm -f

# ── OFF-BOX HOOK (fill before mainnet — P1) ───────────────────────────────
# On-box backups do NOT survive disk/box loss. Wire ONE of these:
#   scp:  scp "$OUT" backup-host:/srv/zbase-backups/
#   s3:   aws s3 cp "$OUT" s3://your-bucket/redis/ --sse AES256
#   cos:  coscmd upload "$OUT" /redis/
# Keep the encryption above regardless — never ship plaintext dumps off-box.
# ──────────────────────────────────────────────────────────────────────────

echo "$(date -u +%FT%TZ) backup OK: $OUT ($SIZE bytes, keep=$KEEP)"
