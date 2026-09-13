#!/usr/bin/env bash
# scripts/seed-phase0-local.sh — Run Phase 0 seed against the local anvil fork.
#
# What this does:
#   1. Confirms anvil is up at http://localhost:${ANVIL_PORT:-8545} (via cast).
#   2. Loads .env.local (TREASURY_PRIVATE_KEY, ZBASE_SEED_ENCRYPTION_KEY, etc).
#   3. OVERRIDES BASE_SEPOLIA_RPC to the local fork URL so seed-phase0.sh and
#      the underlying seeder talk to anvil instead of real Sepolia.
#   4. execs scripts/seed-phase0.sh with the overridden env and forwards args.
#
# Use:
#   ./scripts/seed-phase0-local.sh                # full run (dry-run + confirm + live)
#   ./scripts/seed-phase0-local.sh --dry-run-only # plan only
#
# bash 3.2 safe. No keys are read or echoed.

set -u

if [ -t 2 ]; then
  RED="$(printf '\033[31m')"; YEL="$(printf '\033[33m')"; GRN="$(printf '\033[32m')"
  BLU="$(printf '\033[34m')"; BLD="$(printf '\033[1m')"; RST="$(printf '\033[0m')"
else
  RED=""; YEL=""; GRN=""; BLU=""; BLD=""; RST=""
fi

die()  { printf "%s[seed-local] FATAL:%s %s\n" "$RED$BLD" "$RST" "$1" >&2; exit "${2:-1}"; }
info() { printf "%s[seed-local]%s %s\n"        "$BLU"     "$RST" "$1" >&2; }
ok()   { printf "%s[seed-local] OK:%s %s\n"    "$GRN"     "$RST" "$1" >&2; }
warn() { printf "%s[seed-local] WARN:%s %s\n"  "$YEL"     "$RST" "$1" >&2; }

# ── Resolve repo root ────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

ANVIL_PORT="${ANVIL_PORT:-8545}"
RPC_LOCAL="http://localhost:$ANVIL_PORT"

# ── Tool check ───────────────────────────────────────────────────────────────
CAST_BIN="${CAST_BIN:-$(command -v cast || true)}"
if [ -z "$CAST_BIN" ] && [ -x "$HOME/.foundry/bin/cast" ]; then
  CAST_BIN="$HOME/.foundry/bin/cast"
fi
if [ -z "$CAST_BIN" ]; then
  die "cast binary not found — install Foundry (https://book.getfoundry.sh/getting-started/installation)"
fi

# ── 1. Validate anvil is up ──────────────────────────────────────────────────
info "checking anvil at $RPC_LOCAL"
if ! "$CAST_BIN" block-number --rpc-url "$RPC_LOCAL" >/dev/null 2>&1; then
  die "anvil is not responding at $RPC_LOCAL.
        Start it first:
          ./scripts/anvil-fork-sepolia.sh
        Or, if you started anvil on a different port:
          ANVIL_PORT=<port> ./scripts/seed-phase0-local.sh"
fi
ok "anvil reachable"

# ── 2. Load .env.local (without overriding any var already in env) ──────────
ENV_FILE="$REPO_ROOT/.env.local"
if [ -f "$ENV_FILE" ]; then
  info "sourcing $ENV_FILE (existing env vars take precedence)"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ''|\#*) continue ;;
      *=*)
        key="${line%%=*}"
        key="${key#export }"
        key="$(printf '%s' "$key" | tr -d '[:space:]')"
        # Only set if not already in env
        if [ -z "${!key:-}" ] 2>/dev/null; then
          eval "export $line" 2>/dev/null || true
        fi
        ;;
    esac
  done < "$ENV_FILE"
else
  warn ".env.local not found — relying on already-exported env vars"
fi

# ── 3. OVERRIDE BASE_SEPOLIA_RPC to the local fork ──────────────────────────
# We intentionally override here (not "if unset") — the whole point of this
# wrapper is to redirect the seeder to anvil even when the user has a real
# RPC URL in .env.local.
export BASE_SEPOLIA_RPC="$RPC_LOCAL"
info "BASE_SEPOLIA_RPC overridden to $RPC_LOCAL (local fork)"

# Sanity-check the seeder script exists
SEED_SCRIPT="$REPO_ROOT/scripts/seed-phase0.sh"
if [ ! -x "$SEED_SCRIPT" ]; then
  if [ -f "$SEED_SCRIPT" ]; then
    warn "seed-phase0.sh is not executable — running via bash"
    exec bash "$SEED_SCRIPT" "$@"
  fi
  die "$SEED_SCRIPT not found"
fi

# ── 4. Exec the underlying runbook script ────────────────────────────────────
info "handing off to scripts/seed-phase0.sh $*"
exec "$SEED_SCRIPT" "$@"
