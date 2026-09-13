#!/usr/bin/env bash
# scripts/seed-staging.sh — One-command STAGING seed wrapper.
#
# Identical in shape to scripts/seed-phase0.sh, but targets the staging stack
# (MockUSDC, separate Entrypoint, separate Pool) deployed via
# zbase-protocol/pkg/contracts/script/DeployStaging.s.sol.
#
# What this does:
#   1. Refuses unless STAGING=true is set in the environment.
#   2. Loads .env.local; verifies STAGING_ENTRYPOINT, STAGING_POOL, STAGING_USDC
#      are all set + 42 chars (0x + 40 hex).
#   3. Verifies required env vars are set (TREASURY_PRIVATE_KEY,
#      ZBASE_SEED_ENCRYPTION_KEY, BASE_SEPOLIA_RPC).
#   4. Verifies scripts/seed-pools.staging.config.json exists and contains NO
#      placeholder zeros (treasury / pools[0].address / pools[0].asset /
#      entrypoint must all be replaced).
#   5. Runs `npm run test:seed-pools` as a regression gate (10/10 must pass).
#   6. Runs `tsx scripts/seed-pools.ts --config <staging> --dry-run`.
#   7. Prompts for confirmation, then 5-second countdown.
#   8. Pipes all stdout/stderr to data/seed-staging-run-<UTC-timestamp>.log.
#   9. Verifies the encrypted notes file was written.
#  10. Prints summary.
#
# Flags:
#   --dry-run-only   stop after the dry-run preview (no live tx)
#   --skip-tests     skip the regression-test gate (DISCOURAGED)
#   --help           print usage
#
# Safe to commit: contains no keys or secrets.
# Bash 3.2 safe (macOS default shell).

set -u

# ── Cross-shell terminal colors (POSIX-safe) ──────────────────────────────────
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
  printf "%s[seed-staging] FATAL:%s %s\n" "$RED$BLD" "$RST" "$1" >&2
  exit "${2:-1}"
}

warn() {
  printf "%s[seed-staging] WARN:%s %s\n" "$YEL" "$RST" "$1" >&2
}

info() {
  printf "%s[seed-staging]%s %s\n" "$BLU" "$RST" "$1" >&2
}

ok() {
  printf "%s[seed-staging] OK:%s %s\n" "$GRN" "$RST" "$1" >&2
}

usage() {
  cat >&2 <<'USAGE'
Usage: STAGING=true scripts/seed-staging.sh [--dry-run-only] [--skip-tests] [--help]

One-command STAGING seed wrapper. Refuses to run unless STAGING=true env is set
AND all STAGING_* contract addresses are present in .env.local AND the staging
config has no placeholder zeros remaining.

Flags:
  --dry-run-only   stop after the dry-run preview (no live tx)
  --skip-tests     skip the npm run test:seed-pools regression gate (DISCOURAGED)
  --help           print this message

Required env:
  STAGING=true                explicit opt-in (refuses without it)
  STAGING_ENTRYPOINT          staging Entrypoint address (0x + 40 hex)
  STAGING_POOL                staging Pool address (0x + 40 hex)
  STAGING_USDC                staging MockUSDC address (0x + 40 hex)
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

# ── Step -1: Refuse unless STAGING=true ──────────────────────────────────────
if [ "${STAGING:-}" != "true" ]; then
  die "this script refuses to run unless STAGING=true is set in the environment.
        Usage:  STAGING=true scripts/seed-staging.sh
        Why:    staging seed pipeline should NEVER be invoked accidentally.
                Production seed = scripts/seed-phase0.sh."
fi
ok "STAGING=true gate passed"

# ── Step 0: Load .env.local if present (does not override existing env) ──────
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
        if [ -z "${!key:-}" ] 2>/dev/null; then
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
  - TREASURY_PRIVATE_KEY  (private key controlling staging treasury; must match config.treasury)"
fi
if [ -z "${ZBASE_SEED_ENCRYPTION_KEY:-}" ]; then
  missing_msg="$missing_msg
  - ZBASE_SEED_ENCRYPTION_KEY  (32-byte hex; generate: openssl rand -hex 32)"
fi
if [ -z "${BASE_SEPOLIA_RPC:-}" ]; then
  missing_msg="$missing_msg
  - BASE_SEPOLIA_RPC  (RPC endpoint, e.g. sepolia.base.org)"
fi
if [ -z "${STAGING_ENTRYPOINT:-}" ]; then
  missing_msg="$missing_msg
  - STAGING_ENTRYPOINT  (staging Entrypoint address from DeployStaging.s.sol output)"
fi
if [ -z "${STAGING_POOL:-}" ]; then
  missing_msg="$missing_msg
  - STAGING_POOL  (staging Pool address from DeployStaging.s.sol output)"
fi
if [ -z "${STAGING_USDC:-}" ]; then
  missing_msg="$missing_msg
  - STAGING_USDC  (staging MockUSDC address from DeployStaging.s.sol output)"
fi

if [ -n "$missing_msg" ]; then
  printf "%s[seed-staging] FATAL:%s required env var(s) missing:%s\n" "$RED$BLD" "$RST" "$missing_msg" >&2
  printf "\nSet them in %s/.env.local and re-run.\n" "$REPO_ROOT" >&2
  printf "Get STAGING_* values from the DeployStaging.s.sol broadcast output.\n" >&2
  exit 1
fi

# Sanity-check encryption key format
case "${#ZBASE_SEED_ENCRYPTION_KEY}" in
  64) : ;;
  *) die "ZBASE_SEED_ENCRYPTION_KEY must be exactly 64 hex chars (got ${#ZBASE_SEED_ENCRYPTION_KEY})." ;;
esac
case "$ZBASE_SEED_ENCRYPTION_KEY" in
  *[!0-9a-fA-F]*) die "ZBASE_SEED_ENCRYPTION_KEY must be hex (0-9, a-f)." ;;
esac

# Sanity-check STAGING_* addresses (42 chars, 0x + 40 hex)
check_addr() {
  # $1 = label, $2 = value
  local label="$1" value="$2"
  local len="${#value}"
  if [ "$len" -ne 42 ]; then
    die "$label must be 42 chars (0x + 40 hex), got $len: '$value'"
  fi
  case "$value" in
    0x*) : ;;
    *) die "$label must start with 0x: '$value'" ;;
  esac
  case "$value" in
    0x*[!0-9a-fA-F]*) die "$label must be hex after 0x: '$value'" ;;
  esac
}
check_addr "STAGING_ENTRYPOINT" "$STAGING_ENTRYPOINT"
check_addr "STAGING_POOL" "$STAGING_POOL"
check_addr "STAGING_USDC" "$STAGING_USDC"

ok "env vars present (treasury key, encryption key, RPC URL, STAGING_*)"

# ── Step 2: Config file validation + placeholder check ───────────────────────
CONFIG_PATH="$REPO_ROOT/scripts/seed-pools.staging.config.json"
if [ ! -f "$CONFIG_PATH" ]; then
  die "config file not found: $CONFIG_PATH"
fi

# Use node to inspect the four critical fields. If any equals the zero address,
# refuse — the operator forgot to fill them in after deploying.
ZERO="0x0000000000000000000000000000000000000000"
PLACEHOLDER_REPORT="$(node -e "
const cfg = JSON.parse(require('fs').readFileSync('$CONFIG_PATH','utf8'));
const ZERO = '$ZERO';
const bad = [];
if ((cfg.treasury || '').toLowerCase() === ZERO) bad.push('treasury');
if (!cfg.pools || !cfg.pools[0]) bad.push('pools[0]');
else {
  if ((cfg.pools[0].address || '').toLowerCase() === ZERO) bad.push('pools[0].address');
  if ((cfg.pools[0].asset || '').toLowerCase() === ZERO) bad.push('pools[0].asset');
}
if ((cfg.entrypoint || '').toLowerCase() === ZERO) bad.push('entrypoint');
console.log(bad.join(','));
" 2>/dev/null || printf 'PARSE_ERROR')"

if [ "$PLACEHOLDER_REPORT" = "PARSE_ERROR" ]; then
  die "could not parse $CONFIG_PATH (invalid JSON?)"
fi

if [ -n "$PLACEHOLDER_REPORT" ]; then
  die "staging config still has PLACEHOLDER zero addresses in: $PLACEHOLDER_REPORT
        Edit $CONFIG_PATH and replace each PLACEHOLDER 0x0000...0000 with the
        real staging address printed by DeployStaging.s.sol, then re-run.
        See docs/operations/staging-stack-runbook-2026-05-31.md step 3."
fi

ok "config file present + no placeholder zeros: scripts/seed-pools.staging.config.json"

# ── Step 3: Regression-test gate ─────────────────────────────────────────────
if [ "$SKIP_TESTS" -eq 1 ]; then
  warn "--skip-tests passed: bypassing npm run test:seed-pools."
  warn "This is discouraged. The gate catches the resume-fix regression."
else
  info "running regression gate: npm run test:seed-pools (expect 10/10 PASS)"
  if ! (cd "$REPO_ROOT" && npm run test:seed-pools); then
    die "regression tests failed. Refusing to proceed.
        Re-run manually:    npm run test:seed-pools
        Bypass at own risk: scripts/seed-staging.sh --skip-tests"
  fi
  ok "regression gate: 10/10 PASS"
fi

# ── Step 4: Dry-run preview ──────────────────────────────────────────────────
info "running DRY-RUN to print the plan (no on-chain tx)"
printf '\n'
if ! (cd "$REPO_ROOT" && npx --yes tsx scripts/seed-pools.ts --config "$CONFIG_PATH" --dry-run); then
  die "dry-run failed. Inspect output above — staging config is likely invalid."
fi
printf '\n'
ok "dry-run complete"

if [ "$DRY_RUN_ONLY" -eq 1 ]; then
  info "--dry-run-only passed: stopping here. Re-run without the flag for LIVE."
  exit 0
fi

# ── Step 5: Confirmation + 5s countdown ──────────────────────────────────────
printf "\n%s[seed-staging] PLAN ABOVE.%s This run will spend Base Sepolia gas + MockUSDC.\n" "$BLD$YEL" "$RST" >&2
printf "(MockUSDC has no real value, but gas is still real.)\n" >&2
printf "Type 'yes' to confirm, anything else to abort: " >&2

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
LOG_PATH="$REPO_ROOT/data/seed-staging-run-$TIMESTAMP.log"

info "logging to $LOG_PATH"

set +e
(cd "$REPO_ROOT" && npx --yes tsx scripts/seed-pools.ts --config "$CONFIG_PATH") 2>&1 | tee "$LOG_PATH"
RUN_EXIT="${PIPESTATUS[0]}"
set -e
set +e

if [ "$RUN_EXIT" -ne 0 ]; then
  die "seed-pools.ts exited $RUN_EXIT. Inspect $LOG_PATH for details.
        Staging is for iteration — safe to re-run after diagnosing."
fi

# ── Step 7: Verify encrypted notes were written ──────────────────────────────
NOTES_PATH_REL="$(node -e "console.log(require('$CONFIG_PATH').encryptedNotesPath)" 2>/dev/null || true)"
if [ -z "$NOTES_PATH_REL" ]; then
  warn "could not parse encryptedNotesPath from config; falling back to default"
  NOTES_PATH_REL="data/seed-notes.staging.encrypted.json"
fi

case "$NOTES_PATH_REL" in
  /*) NOTES_PATH="$NOTES_PATH_REL" ;;
  *)  NOTES_PATH="$REPO_ROOT/$NOTES_PATH_REL" ;;
esac

if [ ! -f "$NOTES_PATH" ]; then
  die "expected encrypted notes file not found: $NOTES_PATH
        The run reported success but no file landed on disk.
        Inspect $LOG_PATH for clues."
fi
ok "encrypted notes file written: $NOTES_PATH"

# ── Step 8: Summary ──────────────────────────────────────────────────────────
printf "\n%s========== Staging seed summary ==========%s\n" "$BLD$GRN" "$RST"

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

printf "\n%sNext steps (staging — none required for prod):%s\n" "$BLD" "$RST"
printf "  1. Inspect encrypted notes: %s\n" "$NOTES_PATH"
printf "  2. Iterate. Staging is disposable — re-deploy fresh anytime.\n"
printf "  3. When ready for real USDC, run scripts/seed-phase0.sh instead.\n"
printf "%s==========================================%s\n\n" "$BLD$GRN" "$RST"

exit 0
