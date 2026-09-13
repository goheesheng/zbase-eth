#!/usr/bin/env bash
###############################################################################
# zBase Decoy Scheduler — tmux launcher (macOS + Linux without systemd)
#
# Wraps `npx tsx scripts/decoy-scheduler.ts` in a detached tmux session so the
# founder can close the terminal and the scheduler keeps running. State (notes,
# spent-today, total decoys) is persisted to .decoy-state/deposits.json by the
# script itself, so restarts are safe.
#
# Mark executable once:   chmod +x scripts/decoy-scheduler-launcher.sh
#
# Usage:
#   ./scripts/decoy-scheduler-launcher.sh start     # spawn detached session
#   ./scripts/decoy-scheduler-launcher.sh stop      # graceful SIGTERM + kill
#   ./scripts/decoy-scheduler-launcher.sh status    # PID + last 20 log lines
#   ./scripts/decoy-scheduler-launcher.sh logs      # attach read-only (Ctrl-b d to detach)
#   ./scripts/decoy-scheduler-launcher.sh restart   # stop then start
#
# Flags (also accepted, for legacy callers):  --start --stop --status --logs --restart
###############################################################################

set -euo pipefail

SESSION="zbase-decoy"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="$REPO_ROOT/.decoy-state"
LOG_FILE="$LOG_DIR/decoy-scheduler.log"

mkdir -p "$LOG_DIR"

log() { printf '[launcher] %s\n' "$*"; }
die() { printf '[launcher][err] %s\n' "$*" >&2; exit 1; }

require_tmux() {
  command -v tmux >/dev/null 2>&1 || die "tmux not found. Install with: brew install tmux  (or apt install tmux)"
}

session_exists() {
  tmux has-session -t "$SESSION" 2>/dev/null
}

cmd_start() {
  require_tmux
  if session_exists; then
    die "session '$SESSION' is already running. Use '$0 status' to inspect or '$0 stop' to kill."
  fi
  if [ ! -f "$REPO_ROOT/scripts/decoy-scheduler.ts" ]; then
    die "scripts/decoy-scheduler.ts not found at $REPO_ROOT — wrong working directory?"
  fi
  # Pipe stdout+stderr into a logfile we can tail without attaching.
  # `script -q /dev/null` would preserve TTY colours; tee is simpler and portable.
  tmux new-session -d -s "$SESSION" -c "$REPO_ROOT" \
    "npx tsx scripts/decoy-scheduler.ts 2>&1 | tee -a '$LOG_FILE'"
  sleep 1
  if session_exists; then
    log "started session '$SESSION'"
    log "  logs:   $LOG_FILE"
    log "  attach: $0 logs"
    log "  stop:   $0 stop"
  else
    die "session failed to start — check $LOG_FILE for crash output"
  fi
}

cmd_stop() {
  require_tmux
  if ! session_exists; then
    log "no session '$SESSION' running — nothing to stop"
    return 0
  fi
  # Send Ctrl-C inside the pane so the Node process catches SIGINT and flushes
  # state cleanly (decoy-scheduler.ts has a SIGINT handler that finishes the
  # current cycle before exiting). Then kill the tmux session itself.
  tmux send-keys -t "$SESSION" C-c
  sleep 3
  if session_exists; then
    log "sending tmux kill-session (process didn't exit on SIGINT in 3s)"
    tmux kill-session -t "$SESSION" || true
  fi
  log "stopped session '$SESSION'"
}

cmd_status() {
  if command -v tmux >/dev/null 2>&1 && session_exists; then
    log "session '$SESSION' is RUNNING"
    tmux list-panes -t "$SESSION" -F '  pane=#{pane_id} pid=#{pane_pid} cmd=#{pane_current_command}' || true
  else
    log "session '$SESSION' is NOT running"
  fi
  echo ""
  if [ -f "$LOG_FILE" ]; then
    log "last 20 log lines ($LOG_FILE):"
    tail -n 20 "$LOG_FILE"
  else
    log "no log file yet at $LOG_FILE"
  fi
}

cmd_logs() {
  require_tmux
  if ! session_exists; then
    die "no session '$SESSION' running. Start it with: $0 start"
  fi
  log "attaching read-only to '$SESSION' — press Ctrl-b then d to detach"
  # -r = read-only, prevents accidental keystrokes from killing the scheduler.
  tmux attach-session -r -t "$SESSION"
}

cmd_restart() {
  cmd_stop || true
  sleep 2
  cmd_start
}

case "${1:-}" in
  start|--start)     cmd_start ;;
  stop|--stop)       cmd_stop ;;
  status|--status)   cmd_status ;;
  logs|--logs|tail)  cmd_logs ;;
  restart|--restart) cmd_restart ;;
  -h|--help|help|"")
    sed -n '2,20p' "$0"
    exit 0
    ;;
  *)
    die "unknown command: $1  (try: start | stop | status | logs | restart)"
    ;;
esac
