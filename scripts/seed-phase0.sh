#!/usr/bin/env bash
# scripts/seed-phase0.sh — One-command Phase 0 seed wrapper with safe defaults.
#
# What this does:
#   1. Verifies required env vars are set (TREASURY_PRIVATE_KEY,
#      ZBASE_SEED_ENCRYPTION_KEY, BASE_SEPOLIA_RPC).
#   2. Verifies scripts/seed-pools.phase0.config.json exists.
#   3. Runs `npm run test:seed-pools` as a regression gate (10/10 must pass).
#   4. Runs `tsx scripts/seed-pools.ts --config <phase0> --dry-run` and prints
#      the plan to the operator.
#   5. Prompts for confirmation, then waits 5 seconds (Ctrl-C to abort) before
#      executing the LIVE run.
#   6. Pipes all stdout/stderr to data/seed-phase0-run-<UTC-timestamp>.log.
#   7. Verifies the encrypted notes file was written.
#   8. Prints summary: deposit count, tx hashes (count + first/last), notes path.
#
# Flags:
#   --dry-run-only   stop after the dry-run preview (no live tx)
#   --skip-tests     skip the regression-test gate (DISCOURAGED; prints warning)
#   --help           print usage
#
# Exits non-zero on any failure, with a clear message.
#
# Safe to commit: contains no keys or secrets.

set -u  # treat unset vars as error (but not -e — we want custom error messages)

# ── Cross-shell terminal colors (POSIX-safe, no-op when not a TTY) ────────────
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

die() {
  printf "%s[seed-phase0] FATAL:%s %s\n" "$RED$BLD" "$RST" "$1" >&2
  exit "${2:-1}"
}

warn() {
  printf "%s[seed-phase0] WARN:%s %s\n" "$YEL" "$RST" "$1" >&2
}

info() {
  printf "%s[seed-phase0]%s %s\n" "$BLU" "$RST" "$1" >&2
}

ok() {
  printf "%s[seed-phase0] OK:%s %s\n" "$GRN" "$RST" "$1" >&2
}

usage() {
  cat >&2 <<'USAGE'
Usage: scripts/seed-phase0.sh [--dry-run-only] [--skip-tests] [--help]

One-command Phase 0 seed wrapper. Runs the regression-test gate, shows the
deposit plan, confirms with the operator, then executes the live seed run.

Flags:
  --dry-run-only   stop after the dry-run preview (no live tx)
  --skip-tests     skip the npm run test:seed-pools regression gate (DISCOURAGED)
  --help           print this message

Required env:
  TREASURY_PRIVATE_KEY        signer for deposits (must match config.treasury)
  BASE_SEPOLIA_RPC            RPC endpoint for Base Sepolia
  ZBASE_SEED_ENCRYPTION_KEY   32-byte hex (64 chars) for AES-256-GCM
USAGE
}

# ── Resolve repo root from script location ───────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DRY_RUN_ONLY=0
SKIP_TESTS=0

# Parse args
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run-only) DRY_RUN_ONLY=1; shift ;;
    --skip-tests) SKIP_TESTS=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown flag: $1 (try --help)" 2 ;;
  esac
done

# ── Step 0: Load .env.local if present (does not override existing env) ──────
ENV_FILE="$REPO_ROOT/.env.local"
if [ -f "$ENV_FILE" ]; then
  info "sourcing $ENV_FILE (existing env vars take precedence)"
  # Read line-by-line so we can skip blanks/comments and not override existing.
  # POSIX-safe (no `mapfile`, no process substitution).
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ''|\#*) continue ;;
      *=*)
        key="${line%%=*}"
        # Strip optional leading "export "
        key="${key#export }"
        # Trim leading/trailing whitespace from key
        key="$(printf '%s' "$key" | tr -d '[:space:]')"
        # Only set if not already in env
        if [ -z "${!key:-}" ] 2>/dev/null; then
          # eval is needed for quoted values to expand correctly; this is a
          # trusted local file (.env.local is .gitignored).
          eval "export $line" 2>/dev/null || true
        fi
        ;;
    esac
  done < "$ENV_FILE"
fi

# ── Step 1: Env validation ───────────────────────────────────────────────────
info "validating environment"

missing_msg=""
if [ -z "${TREASURY_PRIVATE_KEY:-}" ]; then
  missing_msg="$missing_msg
  - TREASURY_PRIVATE_KEY  (the private key that controls the treasury wallet — must match config.treasury)"
fi
if [ -z "${ZBASE_SEED_ENCRYPTION_KEY:-}" ]; then
  missing_msg="$missing_msg
  - ZBASE_SEED_ENCRYPTION_KEY  (32-byte hex, generate: openssl rand -hex 32)"
fi
if [ -z "${BASE_SEPOLIA_RPC:-}" ]; then
  missing_msg="$missing_msg
  - BASE_SEPOLIA_RPC  (RPC endpoint, e.g. an Alchemy / Infura / public sepolia.base.org URL)"
fi

if [ -n "$missing_msg" ]; then
  printf "%s[seed-phase0] FATAL:%s required env var(s) missing:%s\n" "$RED$BLD" "$RST" "$missing_msg" >&2
  printf "\nSet them in %s/.env.local and re-run, or export them in your shell.\n" "$REPO_ROOT" >&2
  printf "Do NOT paste private keys into shell history — use the file or a password manager.\n" >&2
  exit 1
fi

# Sanity-check encryption key format (the seed script does too, but better here)
case "${#ZBASE_SEED_ENCRYPTION_KEY}" in
  64) : ;;
  *) die "ZBASE_SEED_ENCRYPTION_KEY must be exactly 64 hex chars (got ${#ZBASE_SEED_ENCRYPTION_KEY}). Generate: openssl rand -hex 32" ;;
esac
case "$ZBASE_SEED_ENCRYPTION_KEY" in
  *[!0-9a-fA-F]*) die "ZBASE_SEED_ENCRYPTION_KEY must be hex (0-9, a-f). Generate: openssl rand -hex 32" ;;
esac

ok "env vars present (treasury key, encryption key, RPC URL)"

# ── Step 2: Config file validation ───────────────────────────────────────────
CONFIG_PATH="$REPO_ROOT/scripts/seed-pools.phase0.config.json"
if [ ! -f "$CONFIG_PATH" ]; then
  die "config file not found: $CONFIG_PATH"
fi
ok "config file present: scripts/seed-pools.phase0.config.json"

# ── Step 3: Regression-test gate ─────────────────────────────────────────────
if [ "$SKIP_TESTS" -eq 1 ]; then
  warn "--skip-tests passed: bypassing the npm run test:seed-pools regression gate."
  warn "This is discouraged. The gate catches the double-deposit-on-resume bug fix"
  warn "(commit 866d625) regressing. Continue only if you cannot run tests on this box."
else
  info "running regression gate: npm run test:seed-pools (expect 10/10 PASS)"
  if ! (cd "$REPO_ROOT" && npm run test:seed-pools); then
    die "regression tests failed. Refusing to proceed — the resume fix may have regressed.
        Re-run the suite manually for details:   npm run test:seed-pools
        Bypass at your own risk:                  scripts/seed-phase0.sh --skip-tests"
  fi
  ok "regression gate: 10/10 PASS"
fi

# ── Step 4: Dry-run preview ──────────────────────────────────────────────────
info "running DRY-RUN to print the plan (no on-chain tx)"
printf '\n'
if ! (cd "$REPO_ROOT" && npx --yes tsx scripts/seed-pools.ts --config "$CONFIG_PATH" --dry-run); then
  die "dry-run failed. Inspect the output above — config is likely invalid."
fi
printf '\n'
ok "dry-run complete"

if [ "$DRY_RUN_ONLY" -eq 1 ]; then
  info "--dry-run-only passed: stopping here. Re-run without the flag to execute LIVE."
  exit 0
fi

# ── Step 5: Confirmation + 5s countdown ──────────────────────────────────────
printf "\n%s[seed-phase0] PLAN ABOVE.%s This run will spend real Base Sepolia USDC + ETH.\n" "$BLD$YEL" "$RST" >&2
printf "Type 'yes' to confirm, anything else to abort: " >&2

# Read with timeout-friendly behaviour — fail closed if no input
read -r CONFIRM || die "no input received; aborting"

case "$CONFIRM" in
  yes|YES|Yes) : ;;
  *) die "operator did not confirm (got: '$CONFIRM'). Aborting." 0 ;;
esac

info "operator confirmed. Starting 5-second countdown — Ctrl-C to abort."
i=5
while [ "$i" -gt 0 ]; do
  printf "  %d...\n" "$i" >&2
  sleep 1
  i=$((i - 1))
done
info "GO."

# ── Step 6: Live run with logging ────────────────────────────────────────────
mkdir -p "$REPO_ROOT/data"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
LOG_PATH="$REPO_ROOT/data/seed-phase0-run-$TIMESTAMP.log"

info "logging to $LOG_PATH"

# Use `tee` to capture both streams. We need the seed-pools.ts exit code,
# not tee's — POSIX `${PIPESTATUS[0]}` works in bash 3.2+ and bash 5+.
set +e
(cd "$REPO_ROOT" && npx --yes tsx scripts/seed-pools.ts --config "$CONFIG_PATH") 2>&1 | tee "$LOG_PATH"
RUN_EXIT="${PIPESTATUS[0]}"
set -e
set +e  # keep custom error handling

if [ "$RUN_EXIT" -ne 0 ]; then
  die "seed-pools.ts exited $RUN_EXIT. Inspect $LOG_PATH for details.
        If a deposit reverted mid-run: do NOT re-run blindly — see runbook
        docs/operations/seed-phase0-runbook-2026-05-31.md, failure mode (d)."
fi

# ── Step 7: Verify encrypted notes were written ──────────────────────────────
# Read encryptedNotesPath from the config (POSIX: use a tiny node one-liner).
NOTES_PATH_REL="$(node -e "console.log(require('$CONFIG_PATH').encryptedNotesPath)" 2>/dev/null || true)"
if [ -z "$NOTES_PATH_REL" ]; then
  warn "could not parse encryptedNotesPath from config; falling back to default"
  NOTES_PATH_REL="data/seed-notes.phase0.encrypted.json"
fi

# Resolve relative to repo root
case "$NOTES_PATH_REL" in
  /*) NOTES_PATH="$NOTES_PATH_REL" ;;
  *)  NOTES_PATH="$REPO_ROOT/$NOTES_PATH_REL" ;;
esac

if [ ! -f "$NOTES_PATH" ]; then
  die "expected encrypted notes file not found: $NOTES_PATH
        The run reported success but no file landed on disk.
        Inspect $LOG_PATH for clues; likely a write permission or path problem."
fi
ok "encrypted notes file written: $NOTES_PATH"

# ── Step 8: Summary ──────────────────────────────────────────────────────────
printf "\n%s========== Phase 0 seed summary ==========%s\n" "$BLD$GRN" "$RST"

# Count deposits + extract tx hashes from the log (the script prints lines of the
# form: "  [N/M] USDC 10 tx=0xABC... commit=...")
DEPOSIT_COUNT="$(grep -cE '^\s*\[[0-9]+/[0-9]+\][[:space:]]+USDC' "$LOG_PATH" 2>/dev/null || printf 0)"
SKIP_COUNT="$(grep -cE '^\s*\[[0-9]+/[0-9]+\][[:space:]]+SKIP' "$LOG_PATH" 2>/dev/null || printf 0)"

printf "  Deposits executed (new):  %s\n" "$DEPOSIT_COUNT"
printf "  Deposits skipped (resumed): %s\n" "$SKIP_COUNT"
printf "  Encrypted notes path:     %s\n" "$NOTES_PATH"
printf "  Run log:                  %s\n" "$LOG_PATH"

if [ "$DEPOSIT_COUNT" -gt 0 ]; then
  FIRST_TX="$(grep -oE 'tx=0x[0-9a-fA-F]+' "$LOG_PATH" | head -n 1 | sed 's/^tx=//')"
  LAST_TX="$(grep -oE 'tx=0x[0-9a-fA-F]+' "$LOG_PATH" | tail -n 1 | sed 's/^tx=//')"
  printf "  First deposit tx:         %s\n" "$FIRST_TX"
  printf "  Last deposit tx:          %s\n" "$LAST_TX"
  printf "  Verify on BaseScan:       https://sepolia.basescan.org/tx/%s\n" "$LAST_TX"
fi

printf "\n%sNext steps:%s\n" "$BLD" "$RST"
printf "  1. Back up %s off-host (S3 with object lock, or 1Password).\n" "$NOTES_PATH"
printf "  2. Confirm ZBASE_SEED_ENCRYPTION_KEY is backed up (Shamir 3-of-5 recommended).\n"
printf "  3. Refresh the ASP root:  curl -X POST http://localhost:3009/api/asp-update\n"
printf "  4. After config.lockUntil, run scripts/reclaim-seed-pools.ts.\n"
printf "%s==========================================%s\n\n" "$BLD$GRN" "$RST"

exit 0
