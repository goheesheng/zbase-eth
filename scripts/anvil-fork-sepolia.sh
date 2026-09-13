#!/usr/bin/env bash
# scripts/anvil-fork-sepolia.sh — Local Base Sepolia fork harness for zBase.
#
# What this does:
#   - Spins up an anvil node that forks Base Sepolia (chain id 84532).
#   - Funds the treasury wallet with ETH (anvil_setBalance) and USDC
#     (anvil_setStorageAt against balanceOf slot 9).
#   - Lets the founder rehearse the full Phase 0 seed pipeline against the
#     fork before requesting real Sepolia USDC ($0 cost, resets on restart).
#
# Flags:
#   (no flag)    start anvil + fund treasury
#   --stop       kill the running anvil + remove pidfile
#   --status     print anvil PID + treasury ETH/USDC balances
#   --mint-only  skip starting anvil, just re-fund treasury (top-ups)
#   --help       print usage
#
# Env (all optional except BASE_SEPOLIA_RPC inside .env.local):
#   BASE_SEPOLIA_RPC   upstream RPC to fork (REQUIRED, read from .env.local; never echoed)
#   ANVIL_PORT         local port           (default 8545)
#   TREASURY_ADDRESS   address to fund      (default 0xcDB447c3a352AD8ADF3D8d97Da9a3CF91880b843)
#   MINT_USDC          USDC units (whole)   (default 10000)
#   MINT_ETH           ETH units (whole)    (default 100)
#
# Notes:
#   - bash 3.2 safe (macOS default). No mapfile, no process substitution.
#   - All operational logs go to stderr. Only the success block prints to stdout.
#   - Pidfile lives at REPO_ROOT/.anvil-fork.pid (gitignored by default — verify).
#   - Safe to commit: contains no keys, no RPC URLs, no addresses other than the
#     public Circle USDC + public treasury address (already in CLAUDE.md).

set -u

# ── Terminal colors (no-op when stderr is not a TTY) ─────────────────────────
if [ -t 2 ]; then
  RED="$(printf '\033[31m')"
  YEL="$(printf '\033[33m')"
  GRN="$(printf '\033[32m')"
  BLU="$(printf '\033[34m')"
  BLD="$(printf '\033[1m')"
  RST="$(printf '\033[0m')"
else
  RED=""; YEL=""; GRN=""; BLU=""; BLD=""; RST=""
fi

die()  { printf "%s[anvil-fork] FATAL:%s %s\n" "$RED$BLD" "$RST" "$1" >&2; exit "${2:-1}"; }
warn() { printf "%s[anvil-fork] WARN:%s %s\n"  "$YEL"     "$RST" "$1" >&2; }
info() { printf "%s[anvil-fork]%s %s\n"        "$BLU"     "$RST" "$1" >&2; }
ok()   { printf "%s[anvil-fork] OK:%s %s\n"    "$GRN"     "$RST" "$1" >&2; }

usage() {
  cat >&2 <<'USAGE'
Usage: scripts/anvil-fork-sepolia.sh [--stop|--status|--mint-only|--help]

Spin up a local Base Sepolia fork and fund the treasury with ETH + USDC,
so Phase 0 seed (and any other on-chain script) can be rehearsed for $0.

Flags:
  (no flag)    start anvil + fund treasury
  --stop       kill the running anvil + remove pidfile
  --status     print anvil PID + treasury ETH/USDC balances
  --mint-only  skip starting anvil, just re-fund treasury (top-ups)
  --help       print this message

Env:
  BASE_SEPOLIA_RPC   upstream RPC to fork (REQUIRED — read from .env.local)
  ANVIL_PORT         local port           (default 8545)
  TREASURY_ADDRESS   address to fund      (default treasury from CLAUDE.md)
  MINT_USDC          whole USDC to mint   (default 10000)
  MINT_ETH           whole ETH to mint    (default 100)
USAGE
}

# ── Resolve repo root from script location ───────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PIDFILE="$REPO_ROOT/.anvil-fork.pid"

# ── Parse args (bash 3.2 safe: no associative arrays) ────────────────────────
MODE="start"
while [ $# -gt 0 ]; do
  case "$1" in
    --stop)       MODE="stop"; shift ;;
    --status)     MODE="status"; shift ;;
    --mint-only)  MODE="mint-only"; shift ;;
    -h|--help)    usage; exit 0 ;;
    *) die "unknown flag: $1 (try --help)" 2 ;;
  esac
done

# ── Defaults ─────────────────────────────────────────────────────────────────
ANVIL_PORT="${ANVIL_PORT:-8545}"
TREASURY_ADDRESS="${TREASURY_ADDRESS:-0xcDB447c3a352AD8ADF3D8d97Da9a3CF91880b843}"
MINT_USDC="${MINT_USDC:-10000}"
MINT_ETH="${MINT_ETH:-100}"
USDC_ADDRESS="0x036CbD53842c5426634e7929541eC2318f3dCF7e"
RPC_LOCAL="http://localhost:$ANVIL_PORT"

# ── Tool checks ──────────────────────────────────────────────────────────────
ANVIL_BIN="${ANVIL_BIN:-$(command -v anvil || true)}"
CAST_BIN="${CAST_BIN:-$(command -v cast || true)}"
if [ -z "$ANVIL_BIN" ] && [ -x "$HOME/.foundry/bin/anvil" ]; then
  ANVIL_BIN="$HOME/.foundry/bin/anvil"
fi
if [ -z "$CAST_BIN" ] && [ -x "$HOME/.foundry/bin/cast" ]; then
  CAST_BIN="$HOME/.foundry/bin/cast"
fi

# ── Helpers ──────────────────────────────────────────────────────────────────
is_pid_alive() {
  # $1 = PID. Returns 0 if alive, 1 otherwise. Works on macOS bash 3.2.
  if [ -z "${1:-}" ]; then return 1; fi
  if kill -0 "$1" 2>/dev/null; then return 0; fi
  return 1
}

read_env_local_var() {
  # $1 = key name. Echoes the value (or empty), reading from .env.local without
  # ever printing the value to stderr. Caller must capture stdout.
  ENV_FILE="$REPO_ROOT/.env.local"
  [ -f "$ENV_FILE" ] || return 0
  KEY="$1"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ''|\#*) continue ;;
      *=*)
        k="${line%%=*}"
        k="${k#export }"
        k="$(printf '%s' "$k" | tr -d '[:space:]')"
        if [ "$k" = "$KEY" ]; then
          v="${line#*=}"
          # Strip surrounding quotes if any
          case "$v" in
            \"*\") v="${v#\"}"; v="${v%\"}" ;;
            \'*\') v="${v#\'}"; v="${v%\'}" ;;
          esac
          printf '%s' "$v"
          return 0
        fi
        ;;
    esac
  done < "$ENV_FILE"
  return 0
}

# Compute hex of a whole-number * 10^N safely (no bash 64-bit overflow for ETH).
# $1 = whole number (decimal string), $2 = exponent. Echoes "0x<hex>".
to_wei_hex() {
  AMOUNT="$1"; EXP="$2"
  # Build the decimal as a python/node-free integer in a string, then convert
  # using printf when small enough, otherwise via cast --to-hex.
  # bash native math overflows for 100 * 10^18, so we use cast for safety.
  if [ -z "$CAST_BIN" ]; then
    die "cast binary not found — install Foundry (https://book.getfoundry.sh/getting-started/installation)"
  fi
  # Build the decimal string: amount followed by EXP zeros
  ZEROS=""
  i=0
  while [ "$i" -lt "$EXP" ]; do
    ZEROS="${ZEROS}0"
    i=$((i + 1))
  done
  DEC="${AMOUNT}${ZEROS}"
  "$CAST_BIN" --to-hex "$DEC"
}

# Same as to_wei_hex but pads to 32 bytes (64 hex chars) for storage slot writes.
to_storage_hex() {
  AMOUNT="$1"; EXP="$2"
  RAW="$(to_wei_hex "$AMOUNT" "$EXP")"
  # Strip leading 0x, pad with leading zeros to 64
  STRIP="${RAW#0x}"
  STRIP="${STRIP#0X}"
  # bash 3.2 safe: build pad
  LEN=${#STRIP}
  PAD_LEN=$((64 - LEN))
  if [ "$PAD_LEN" -lt 0 ]; then
    die "amount $AMOUNT * 10^$EXP exceeds 32 bytes — too big to fit in a storage slot"
  fi
  PAD=""
  i=0
  while [ "$i" -lt "$PAD_LEN" ]; do
    PAD="${PAD}0"
    i=$((i + 1))
  done
  printf '0x%s%s' "$PAD" "$STRIP"
}

print_treasury_balances() {
  if [ -z "$CAST_BIN" ]; then return 0; fi
  ETH_WEI="$("$CAST_BIN" balance "$TREASURY_ADDRESS" --rpc-url "$RPC_LOCAL" 2>/dev/null || printf '0')"
  ETH_HUMAN="$("$CAST_BIN" from-wei "$ETH_WEI" 2>/dev/null || printf '?')"
  USDC_RAW="$("$CAST_BIN" call "$USDC_ADDRESS" 'balanceOf(address)(uint256)' "$TREASURY_ADDRESS" --rpc-url "$RPC_LOCAL" 2>/dev/null || printf '0')"
  # cast prints "12345 [1.2e4]" sometimes; cut to just the integer
  USDC_RAW="${USDC_RAW%% *}"
  # Convert USDC raw (6 decimals) to human — bash arithmetic OK at this scale
  if [ -n "$USDC_RAW" ] && [ "$USDC_RAW" != "0" ]; then
    USDC_WHOLE=$((USDC_RAW / 1000000))
    USDC_FRAC=$((USDC_RAW % 1000000))
    USDC_HUMAN="$(printf '%d.%06d' "$USDC_WHOLE" "$USDC_FRAC")"
  else
    USDC_HUMAN="0.000000"
  fi
  printf '  ETH:  %s\n' "$ETH_HUMAN"
  printf '  USDC: %s\n' "$USDC_HUMAN"
}

fund_treasury() {
  if [ -z "$CAST_BIN" ]; then
    die "cast binary not found — install Foundry"
  fi

  # 1. ETH via anvil_setBalance
  info "minting $MINT_ETH ETH to $TREASURY_ADDRESS"
  ETH_HEX="$(to_wei_hex "$MINT_ETH" 18)"
  if ! "$CAST_BIN" rpc anvil_setBalance "$TREASURY_ADDRESS" "$ETH_HEX" --rpc-url "$RPC_LOCAL" >/dev/null 2>&1; then
    die "anvil_setBalance failed — is anvil running on $RPC_LOCAL?"
  fi

  # 2. USDC via anvil_setStorageAt (slot 9 = balanceOf mapping, verified empirically)
  info "minting $MINT_USDC USDC to $TREASURY_ADDRESS (storage slot 9)"
  USDC_KEY="$("$CAST_BIN" index address "$TREASURY_ADDRESS" 9)"
  USDC_VAL="$(to_storage_hex "$MINT_USDC" 6)"
  if ! "$CAST_BIN" rpc anvil_setStorageAt "$USDC_ADDRESS" "$USDC_KEY" "$USDC_VAL" --rpc-url "$RPC_LOCAL" >/dev/null 2>&1; then
    die "anvil_setStorageAt failed — is anvil running on $RPC_LOCAL?"
  fi

  ok "treasury funded"
}

verify_anvil_running() {
  # Returns 0 if anvil responds on $RPC_LOCAL within 1 RPC call.
  if [ -z "$CAST_BIN" ]; then return 1; fi
  "$CAST_BIN" block-number --rpc-url "$RPC_LOCAL" >/dev/null 2>&1
}

# ── Mode dispatch ────────────────────────────────────────────────────────────

case "$MODE" in

  stop)
    if [ ! -f "$PIDFILE" ]; then
      warn "no pidfile at $PIDFILE — nothing to stop (or it was started outside this script)"
      exit 0
    fi
    PID="$(cat "$PIDFILE" 2>/dev/null || true)"
    if is_pid_alive "$PID"; then
      info "killing anvil PID $PID"
      kill "$PID" 2>/dev/null || true
      # Give it 2s to exit cleanly, then SIGKILL
      i=0
      while [ "$i" -lt 4 ] && is_pid_alive "$PID"; do
        sleep 0.5
        i=$((i + 1))
      done
      if is_pid_alive "$PID"; then
        warn "PID $PID didn't exit on SIGTERM — sending SIGKILL"
        kill -9 "$PID" 2>/dev/null || true
      fi
      ok "anvil stopped"
    else
      warn "PID $PID from pidfile is not alive — removing stale pidfile"
    fi
    rm -f "$PIDFILE"
    exit 0
    ;;

  status)
    if [ ! -f "$PIDFILE" ]; then
      printf 'anvil: not running (no pidfile)\n'
      exit 0
    fi
    PID="$(cat "$PIDFILE" 2>/dev/null || true)"
    if ! is_pid_alive "$PID"; then
      printf 'anvil: pidfile exists but PID %s is dead (stale pidfile)\n' "$PID"
      exit 1
    fi
    printf 'anvil: running PID=%s port=%s\n' "$PID" "$ANVIL_PORT"
    printf 'treasury %s:\n' "$TREASURY_ADDRESS"
    print_treasury_balances
    exit 0
    ;;

  mint-only)
    if ! verify_anvil_running; then
      die "anvil is not responding on $RPC_LOCAL — start it first with ./scripts/anvil-fork-sepolia.sh"
    fi
    fund_treasury
    info "verifying balances on $RPC_LOCAL"
    print_treasury_balances >&2
    printf 'Treasury %s re-funded on %s\n' "$TREASURY_ADDRESS" "$RPC_LOCAL"
    print_treasury_balances
    exit 0
    ;;

  start)
    # ── Refuse double-start ──────────────────────────────────────────────────
    if [ -f "$PIDFILE" ]; then
      EXISTING_PID="$(cat "$PIDFILE" 2>/dev/null || true)"
      if is_pid_alive "$EXISTING_PID"; then
        die "anvil already running (PID $EXISTING_PID, pidfile $PIDFILE).
        Stop it first: ./scripts/anvil-fork-sepolia.sh --stop"
      else
        warn "stale pidfile (PID $EXISTING_PID dead) — removing"
        rm -f "$PIDFILE"
      fi
    fi

    if [ -z "$ANVIL_BIN" ]; then
      die "anvil binary not found — install Foundry (https://book.getfoundry.sh/getting-started/installation)"
    fi
    if [ -z "$CAST_BIN" ]; then
      die "cast binary not found — install Foundry"
    fi

    # ── Load BASE_SEPOLIA_RPC from .env.local (never echo) ───────────────────
    info "reading BASE_SEPOLIA_RPC from .env.local"
    BASE_SEPOLIA_RPC_VAL="${BASE_SEPOLIA_RPC:-$(read_env_local_var BASE_SEPOLIA_RPC)}"
    if [ -z "$BASE_SEPOLIA_RPC_VAL" ]; then
      die "BASE_SEPOLIA_RPC not found in env or .env.local — required to fork"
    fi
    ok "BASE_SEPOLIA_RPC loaded (value not echoed)"

    # ── Start anvil in background ────────────────────────────────────────────
    info "starting anvil fork on port $ANVIL_PORT (chain-id 84532, auto-impersonate)"
    # Redirect anvil stdout/stderr to a log to keep terminal clean. The URL is
    # in the command line so any process listing will leak it — we accept this
    # tradeoff (founder's own machine, founder's own RPC key).
    ANVIL_LOG="$REPO_ROOT/.anvil-fork.log"
    : > "$ANVIL_LOG"
    # --block-time 2: match Base Sepolia's actual ~2s block production.
    # Earlier --block-time 1 was too fast for viem's waitForTransactionReceipt
    # polling cadence; faster also caused receipts to land in blocks before
    # viem started polling, triggering BlockNotFoundError on getBlock.
    # 2s matches mainnet behaviour so the test exercises the same timing
    # the production push will see.
    #
    # --no-mining alternative (rejected): instant-mine per-tx breaks
    # multi-tx-in-flight scripts. seed-pools.ts queues approve + 30 deposits
    # rapidly and relies on real block production order.
    "$ANVIL_BIN" \
      --fork-url "$BASE_SEPOLIA_RPC_VAL" \
      --port "$ANVIL_PORT" \
      --chain-id 84532 \
      --auto-impersonate \
      --block-time 2 \
      --silent \
      >>"$ANVIL_LOG" 2>&1 &
    ANVIL_PID=$!
    printf '%s' "$ANVIL_PID" > "$PIDFILE"
    info "anvil PID $ANVIL_PID (log: $ANVIL_LOG)"

    # ── Wait up to 30s for anvil to be ready ─────────────────────────────────
    info "waiting up to 30s for anvil to respond"
    i=0
    READY=0
    while [ "$i" -lt 60 ]; do
      if verify_anvil_running; then
        READY=1
        break
      fi
      # Bail early if anvil already died
      if ! is_pid_alive "$ANVIL_PID"; then
        warn "anvil PID $ANVIL_PID exited before becoming ready"
        rm -f "$PIDFILE"
        warn "tail of $ANVIL_LOG:"
        tail -n 20 "$ANVIL_LOG" >&2 || true
        die "anvil failed to start"
      fi
      sleep 0.5
      i=$((i + 1))
    done
    if [ "$READY" -ne 1 ]; then
      kill "$ANVIL_PID" 2>/dev/null || true
      rm -f "$PIDFILE"
      die "anvil did not become ready within 30s — check $ANVIL_LOG"
    fi
    ok "anvil is responding on $RPC_LOCAL"

    # ── Fund the treasury ────────────────────────────────────────────────────
    fund_treasury

    # ── Verify and report ────────────────────────────────────────────────────
    info "verifying balances on $RPC_LOCAL"
    print_treasury_balances >&2

    # ── Success block (stdout) ───────────────────────────────────────────────
    printf 'Anvil running at %s (PID: %s)\n' "$RPC_LOCAL" "$ANVIL_PID"
    printf 'Treasury %s funded:\n' "$TREASURY_ADDRESS"
    print_treasury_balances
    printf '\n'
    printf 'Run seed against the fork:\n'
    printf '  ./scripts/seed-phase0-local.sh\n'
    printf '\n'
    printf 'Top up balances later (e.g. between test runs):\n'
    printf '  ./scripts/anvil-fork-sepolia.sh --mint-only\n'
    printf '\n'
    printf 'Check status:\n'
    printf '  ./scripts/anvil-fork-sepolia.sh --status\n'
    printf '\n'
    printf 'Stop anvil:\n'
    printf '  ./scripts/anvil-fork-sepolia.sh --stop\n'
    exit 0
    ;;
esac
