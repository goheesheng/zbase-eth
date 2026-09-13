#!/usr/bin/env bash
###############################################################################
# zBase Decoy Scheduler — staleness watchdog
#
# Why: scripts/decoy-scheduler.ts is the only mechanism enforcing FIFO-
# resistance (A.2). If it dies silently — process killed, OOM, RPC permanently
# down, daily budget cap stuck — the privacy claim quietly degrades and nobody
# notices for days. This watchdog turns that silent failure into a loud one
# within ZBASE_DECOY_MAX_AGE_SEC (default 6h).
#
# How: the scheduler appends a line per cycle (`[decoy] cycle=N ...`) every
# ~MEAN_SECONDS via either `tee -a` (tmux launcher) or systemd `append:` mode.
# Both update the log file's mtime on every write, on both macOS and Linux.
# We compare that mtime against `now`. If the file doesn't exist at all,
# that's a different failure mode (never started) and exits with a different code.
#
# Bash 3.2 safe (macOS default shell). No bashisms beyond what 3.2 supports.
#
# Modes:
#   ./scripts/decoy-watchdog.sh                 # one-shot, verbose (default)
#   ./scripts/decoy-watchdog.sh --once          # same as default; explicit cron mode
#   ./scripts/decoy-watchdog.sh --once --quiet  # silent on success — cron-friendly
#   ./scripts/decoy-watchdog.sh --loop=900      # check every 900s, tmux-style
#
# Exit codes:
#   0  healthy
#   1  stale  (log exists but no writes in MAX_AGE_SEC)
#   2  missing (log file does not exist)
#   3  bad CLI args / internal error
#
# Env:
#   ZBASE_DECOY_LOG          default .decoy-state/decoy-scheduler.log (repo-relative)
#   ZBASE_DECOY_MAX_AGE_SEC  default 21600 (6h)
#   ZBASE_DECOY_WEBHOOK      if set, POST a JSON body to this URL on stale/missing
###############################################################################

set -u  # do NOT use -e: we want to keep going on webhook curl failures
# Avoid `set -o pipefail` for Bash 3.2 portability concerns in subshells.

# ── Defaults ──
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEFAULT_LOG="$REPO_ROOT/.decoy-state/decoy-scheduler.log"

LOG_PATH="${ZBASE_DECOY_LOG:-$DEFAULT_LOG}"
MAX_AGE_SEC="${ZBASE_DECOY_MAX_AGE_SEC:-21600}"
WEBHOOK="${ZBASE_DECOY_WEBHOOK:-}"

QUIET=0
LOOP_INTERVAL=0   # 0 == single-shot

# ── Arg parsing (Bash 3.2: no `${var,,}` lowercasing, no `[[ =~ ]]` for portability) ──
for arg in "$@"; do
  case "$arg" in
    --quiet)        QUIET=1 ;;
    --once)         LOOP_INTERVAL=0 ;;
    --loop=*)       LOOP_INTERVAL="${arg#--loop=}" ;;
    -h|--help|help)
      sed -n '2,30p' "$0"
      exit 0
      ;;
    *)
      printf '[watchdog][err] unknown arg: %s\n' "$arg" >&2
      exit 3
      ;;
  esac
done

# Validate LOOP_INTERVAL is a positive integer (or 0)
case "$LOOP_INTERVAL" in
  ''|*[!0-9]*) printf '[watchdog][err] --loop must be a positive integer (seconds)\n' >&2; exit 3 ;;
esac

# ── ANSI colour helpers (only when stderr is a TTY) ──
if [ -t 2 ]; then
  C_RED=$'\033[1;31m'
  C_GREEN=$'\033[0;32m'
  C_YELLOW=$'\033[1;33m'
  C_RESET=$'\033[0m'
else
  C_RED=""; C_GREEN=""; C_YELLOW=""; C_RESET=""
fi

# ── Portable file-mtime (epoch seconds). macOS = stat -f %m, Linux = stat -c %Y ──
file_mtime() {
  local f="$1"
  local m
  m=$(stat -f %m "$f" 2>/dev/null) || m=$(stat -c %Y "$f" 2>/dev/null) || m=""
  printf '%s' "$m"
}

# ── Render seconds → "Xh Ym" ──
human_age() {
  local s="$1"
  local h=$(( s / 3600 ))
  local m=$(( (s % 3600) / 60 ))
  printf '%dh %dm' "$h" "$m"
}

# ── Webhook poster — never fails the watchdog if curl errors ──
post_webhook() {
  # $1=status (stale|missing) $2=age string $3=log path
  [ -z "$WEBHOOK" ] && return 0
  if ! command -v curl >/dev/null 2>&1; then
    printf '[watchdog] curl not available; skipping webhook\n' >&2
    return 0
  fi
  local body
  body=$(printf '{"service":"zbase-decoy","status":"%s","lastActivityAgo":"%s","logPath":"%s"}' \
    "$1" "$2" "$3")
  printf '[watchdog] posting webhook → %s\n' "$WEBHOOK" >&2
  # 5s connect, 10s total; don't let a hung pager hang the watchdog
  curl -fsS --max-time 10 --connect-timeout 5 \
    -X POST -H 'content-type: application/json' \
    -d "$body" "$WEBHOOK" >/dev/null 2>&1 \
    || printf '[watchdog] webhook POST failed (continuing)\n' >&2
}

# ── Single check; returns exit code via stdout suppression / return ──
run_check() {
  if [ ! -f "$LOG_PATH" ]; then
    printf '%s⚠️  DECOY SCHEDULER NOT STARTED — log file missing at %s%s\n' \
      "$C_YELLOW" "$LOG_PATH" "$C_RESET" >&2
    post_webhook "missing" "n/a" "$LOG_PATH"
    return 2
  fi

  local mtime now age
  mtime=$(file_mtime "$LOG_PATH")
  if [ -z "$mtime" ]; then
    printf '%s[watchdog][err] could not stat %s%s\n' "$C_RED" "$LOG_PATH" "$C_RESET" >&2
    return 3
  fi
  now=$(date +%s)
  age=$(( now - mtime ))

  if [ "$age" -gt "$MAX_AGE_SEC" ]; then
    local human
    human=$(human_age "$age")
    printf '%s🚨 DECOY SCHEDULER STALE — last activity %s ago (log: %s)%s\n' \
      "$C_RED" "$human" "$LOG_PATH" "$C_RESET" >&2
    post_webhook "stale" "$human" "$LOG_PATH"
    return 1
  fi

  if [ "$QUIET" -eq 0 ]; then
    printf '%s✓ decoy scheduler healthy — last activity %ss ago%s\n' \
      "$C_GREEN" "$age" "$C_RESET"
  fi
  return 0
}

# ── Driver ──
if [ "$LOOP_INTERVAL" -eq 0 ]; then
  run_check
  exit $?
fi

# Loop mode: keep going forever, emit one line per tick on failure.
# Healthy ticks stay silent in loop mode regardless of --quiet so the operator
# isn't drowned in green checkmarks.
printf '[watchdog] loop mode: checking every %ss (log=%s, max-age=%ss)\n' \
  "$LOOP_INTERVAL" "$LOG_PATH" "$MAX_AGE_SEC" >&2
QUIET=1
while true; do
  run_check || true
  sleep "$LOOP_INTERVAL"
done
