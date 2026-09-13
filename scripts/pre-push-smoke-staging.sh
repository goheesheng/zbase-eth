#!/usr/bin/env bash
# scripts/pre-push-smoke-staging.sh — One-shot READY / NOT READY verdict for the
# STAGING stack (MockUSDC on Base Sepolia). Mirrors pre-push-smoke.sh but
# targets STAGING_ENTRYPOINT / STAGING_POOL / STAGING_USDC instead of the real
# production addresses, and reads scripts/seed-pools.staging.config.json.
#
# Phases:
#   1. env + STAGING_* address validation (no chain interaction)
#   2. offline test gates (npm run test:seed-pools)
#   3. STAGING_USDC.balanceOf(treasury) probe — warn if < $800 MockUSDC
#   4. seed-pools.ts --dry-run with seed-pools.staging.config.json
#   5. verdict block
#
# Flags:
#   --quiet           suppress per-test output (only the verdict block prints)
#   --help            print usage
#
# Exit codes:
#   0  READY              (all hard gates pass)
#   1  NOT READY          (any hard gate fails)
#   2  PUSH WITH WARNINGS (hard gates pass; treasury balance low)
#
# Constraints:
#   - bash 3.2 safe (runs on macOS)
#   - Never logs env values, even partially
#   - Never makes a state-changing chain call
#   - Tees all output to data/pre-push-smoke-staging-<UTC>.log

set -u

# ── Cross-shell terminal colors (POSIX-safe) ──────────────────────────────────
if [ -t 1 ]; then
  RED="$(printf '\033[31m')"
  YEL="$(printf '\033[33m')"
  GRN="$(printf '\033[32m')"
  BLU="$(printf '\033[34m')"
  BLD="$(printf '\033[1m')"
  DIM="$(printf '\033[2m')"
  RST="$(printf '\033[0m')"
else
  RED=""; YEL=""; GRN=""; BLU=""; BLD=""; DIM=""; RST=""
fi

# ── Globals ──────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
NOW_HUMAN="$(date -u +'%Y-%m-%d %H:%M:%SZ')"
LOG_DIR="$REPO_ROOT/data"
LOG_PATH="$LOG_DIR/pre-push-smoke-staging-$TIMESTAMP.log"

QUIET=0

PHASE1_STATUS=0
PHASE2_STATUS=0
PHASE3_STATUS=0
PHASE4_STATUS=0
PHASE3_WARN_COUNT=0

GIT_BRANCH=""

# ── CLI parsing ──────────────────────────────────────────────────────────────
usage() {
  cat <<'USAGE'
Usage: scripts/pre-push-smoke-staging.sh [--quiet] [--help]

One-shot READY / NOT READY verdict for the STAGING stack. Validates the
STAGING_* env vars, runs offline tests, probes treasury MockUSDC balance,
and dry-runs the staging seed plan.

Flags:
  --quiet           suppress per-test output; only the verdict block prints
  --help            this message

Exit codes:
  0  READY              (all hard gates pass)
  1  NOT READY          (any hard gate failed)
  2  PUSH WITH WARNINGS (hard gates pass; treasury balance low)

Output is teed to data/pre-push-smoke-staging-<UTC>.log.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --quiet)   QUIET=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf "unknown flag: %s (try --help)\n" "$1" >&2; exit 2 ;;
  esac
done

# ── Logging helpers ──────────────────────────────────────────────────────────
mkdir -p "$LOG_DIR"
: > "$LOG_PATH"

emit() {
  printf '%s\n' "$*" >> "$LOG_PATH"
  if [ "$QUIET" -eq 0 ]; then
    printf '%s\n' "$*"
  fi
}

emit_loud() {
  printf '%s\n' "$*" >> "$LOG_PATH"
  printf '%s\n' "$*"
}

info()  { emit "${BLU}[pre-push-staging]${RST} $*"; }
ok()    { emit "${GRN}[pre-push-staging] OK:${RST} $*"; }
warn()  { emit "${YEL}[pre-push-staging] WARN:${RST} $*"; }
fail()  { emit "${RED}[pre-push-staging] FAIL:${RST} $*"; }
hdr()   { emit ""; emit "${BLD}=== $* ===${RST}"; }

run_cmd() {
  label="$1"; shift
  emit "${DIM}\$ $*${RST}"
  set +e
  if [ "$QUIET" -eq 1 ]; then
    output="$("$@" 2>&1)"
    rc=$?
    printf '%s\n' "$output" >> "$LOG_PATH"
  else
    tmp="$(mktemp -t prepush-stg.XXXXXX)"
    "$@" >"$tmp" 2>&1
    rc=$?
    cat "$tmp" | tee -a "$LOG_PATH"
    rm -f "$tmp"
  fi
  set -u
  return $rc
}

# Read a value out of .env.local without echoing it.
# $1 = key, $2 = env file path. Echoes the bare value (no quotes) on stdout.
read_env_value() {
  local key="$1" file="$2"
  if [ ! -f "$file" ]; then return 1; fi
  grep -E "^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*=" "$file" 2>/dev/null \
    | head -n1 \
    | sed -E "s/^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*=//" \
    | sed -e 's/^["'\'']//' -e 's/["'\'']$//'
}

# Validate that a value is a 42-char 0x-prefixed hex address.
# $1 = label, $2 = value. Returns 0 if valid, 1 otherwise.
is_valid_address() {
  local label="$1" value="$2"
  local len="${#value}"
  if [ "$len" -ne 42 ]; then
    fail "$label is not 42 chars (got $len) — expected 0x + 40 hex"
    return 1
  fi
  case "$value" in
    0x*) : ;;
    *) fail "$label does not start with 0x"; return 1 ;;
  esac
  case "$value" in
    0x*[!0-9a-fA-F]*) fail "$label has non-hex chars"; return 1 ;;
  esac
  return 0
}

# ── Phase 1: env + STAGING_* validation ──────────────────────────────────────
phase1() {
  hdr "Phase 1 — env + STAGING_* address validation"
  local failed=0

  local env_file="$REPO_ROOT/.env.local"
  if [ ! -f "$env_file" ]; then
    fail ".env.local not found at $env_file"
    PHASE1_STATUS=1
    return
  fi
  ok ".env.local present"

  # STAGING_ENTRYPOINT
  local stg_ep
  stg_ep="$(read_env_value STAGING_ENTRYPOINT "$env_file" || true)"
  if [ -z "$stg_ep" ]; then
    fail "STAGING_ENTRYPOINT missing from .env.local — paste output from DeployStaging.s.sol"
    failed=1
  else
    if is_valid_address "STAGING_ENTRYPOINT" "$stg_ep"; then
      ok "STAGING_ENTRYPOINT valid (42-char address)"
    else
      failed=1
    fi
  fi

  # STAGING_POOL
  local stg_pool
  stg_pool="$(read_env_value STAGING_POOL "$env_file" || true)"
  if [ -z "$stg_pool" ]; then
    fail "STAGING_POOL missing from .env.local — paste output from DeployStaging.s.sol"
    failed=1
  else
    if is_valid_address "STAGING_POOL" "$stg_pool"; then
      ok "STAGING_POOL valid (42-char address)"
    else
      failed=1
    fi
  fi

  # STAGING_USDC
  local stg_usdc
  stg_usdc="$(read_env_value STAGING_USDC "$env_file" || true)"
  if [ -z "$stg_usdc" ]; then
    fail "STAGING_USDC missing from .env.local — paste output from DeployStaging.s.sol"
    failed=1
  else
    if is_valid_address "STAGING_USDC" "$stg_usdc"; then
      ok "STAGING_USDC valid (42-char address)"
    else
      failed=1
    fi
  fi

  # BASE_SEPOLIA_RPC existence
  if grep -Eq "^[[:space:]]*(export[[:space:]]+)?BASE_SEPOLIA_RPC[[:space:]]*=.+" "$env_file" 2>/dev/null; then
    ok "BASE_SEPOLIA_RPC is set"
  else
    fail "BASE_SEPOLIA_RPC missing"
    failed=1
  fi

  # tooling
  if command -v node >/dev/null 2>&1; then
    ok "node available ($(node --version 2>/dev/null))"
  else
    fail "node not on PATH"
    failed=1
  fi
  if command -v npx >/dev/null 2>&1; then
    ok "npx available"
  else
    fail "npx not on PATH"
    failed=1
  fi

  # git + branch
  if command -v git >/dev/null 2>&1; then
    GIT_BRANCH="$(cd "$REPO_ROOT" && git rev-parse --abbrev-ref HEAD 2>/dev/null || printf 'unknown')"
    ok "git available, current branch: $GIT_BRANCH"
  else
    fail "git not on PATH"
    GIT_BRANCH="unknown"
    failed=1
  fi

  # staging config exists + valid JSON
  local cfg="$REPO_ROOT/scripts/seed-pools.staging.config.json"
  if [ ! -f "$cfg" ]; then
    fail "scripts/seed-pools.staging.config.json not found"
    failed=1
  else
    if node -e "JSON.parse(require('fs').readFileSync('$cfg','utf8'))" >/dev/null 2>&1; then
      ok "seed-pools.staging.config.json present and valid JSON"
    else
      fail "seed-pools.staging.config.json is not valid JSON"
      failed=1
    fi
  fi

  # scrub
  stg_ep=""; stg_pool=""; stg_usdc=""

  PHASE1_STATUS=$failed
  if [ $failed -eq 0 ]; then
    ok "Phase 1 PASS"
  else
    fail "Phase 1 FAIL"
  fi
}

# ── Phase 2: offline test gates ──────────────────────────────────────────────
phase2() {
  hdr "Phase 2 — offline test gates"
  local failed=0

  info "running: npm run test:seed-pools"
  if (cd "$REPO_ROOT" && run_cmd "test:seed-pools" npm run test:seed-pools --silent); then
    ok "npm run test:seed-pools PASS"
  else
    fail "npm run test:seed-pools FAILED — see $LOG_PATH"
    failed=1
  fi

  PHASE2_STATUS=$failed
  if [ $failed -eq 0 ]; then
    ok "Phase 2 PASS"
  else
    fail "Phase 2 FAIL"
  fi
}

# ── Phase 3: STAGING_USDC.balanceOf(treasury) probe (warn-only) ──────────────
phase3() {
  hdr "Phase 3 — STAGING_USDC.balanceOf(treasury) probe"
  PHASE3_WARN_COUNT=0

  local env_file="$REPO_ROOT/.env.local"
  local rpc_url stg_usdc treasury_addr
  rpc_url="$(read_env_value BASE_SEPOLIA_RPC "$env_file" || true)"
  stg_usdc="$(read_env_value STAGING_USDC "$env_file" || true)"
  # Read treasury from the staging config (public address only — never the key)
  treasury_addr="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$REPO_ROOT/scripts/seed-pools.staging.config.json','utf8')).treasury || '')" 2>/dev/null || true)"

  if [ -z "$rpc_url" ] || [ -z "$stg_usdc" ] || [ -z "$treasury_addr" ]; then
    warn "cannot probe MockUSDC balance (missing RPC, STAGING_USDC, or treasury in config)"
    PHASE3_WARN_COUNT=$((PHASE3_WARN_COUNT + 1))
    PHASE3_STATUS=0
    return
  fi

  # If treasury is still the placeholder zero, warn loudly
  case "$treasury_addr" in
    0x0000000000000000000000000000000000000000)
      warn "config treasury is still PLACEHOLDER zero — fill it in before running seed-staging.sh"
      PHASE3_WARN_COUNT=$((PHASE3_WARN_COUNT + 1))
      PHASE3_STATUS=0
      return
      ;;
  esac

  if ! command -v cast >/dev/null 2>&1; then
    warn "cast not installed — skipping MockUSDC balance probe"
    PHASE3_STATUS=0
    return
  fi

  info "probing STAGING_USDC.balanceOf($treasury_addr)"
  local usdc_raw usdc_dec
  usdc_raw="$(cast call --rpc-url "$rpc_url" "$stg_usdc" "balanceOf(address)(uint256)" "$treasury_addr" 2>/dev/null | awk '{print $1}' || true)"
  if [ -z "$usdc_raw" ]; then
    warn "could not read MockUSDC balance — STAGING_USDC may not be deployed at $stg_usdc"
    PHASE3_WARN_COUNT=$((PHASE3_WARN_COUNT + 1))
  else
    usdc_dec="$(node -e "const w=BigInt('$usdc_raw'); console.log((Number(w)/1e6).toFixed(2))" 2>/dev/null || printf '?')"
    # Warn if < 800 MockUSDC (staging needs $800)
    local low_usdc
    low_usdc="$(node -e "console.log(BigInt('$usdc_raw') < BigInt('800000000') ? 1 : 0)" 2>/dev/null || printf 0)"
    if [ "$low_usdc" = "1" ]; then
      warn "treasury MockUSDC balance LOW: \$$usdc_dec (< \$800 needed). Mint more:
        cast send \$STAGING_USDC 'mint(address,uint256)' \$TREASURY 1000000000 \\
          --private-key \$POSTMAN_PRIVATE_KEY --rpc-url \$BASE_SEPOLIA_RPC"
      PHASE3_WARN_COUNT=$((PHASE3_WARN_COUNT + 1))
    else
      ok "treasury MockUSDC balance: \$$usdc_dec (sufficient for \$800 staging seed)"
    fi
  fi

  rpc_url=""; stg_usdc=""; treasury_addr=""
  PHASE3_STATUS=0  # warn-only phase, never hard-fails
  info "Phase 3 complete: $PHASE3_WARN_COUNT warning(s)"
}

# ── Phase 4: seed-pools dry-run with staging config ──────────────────────────
phase4() {
  hdr "Phase 4 — seed-pools.ts --dry-run (staging config)"
  local failed=0

  # Load .env.local so seed-pools.ts sees TREASURY_PRIVATE_KEY, etc.
  local env_file="$REPO_ROOT/.env.local"
  if [ -f "$env_file" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in
        ''|\#*) continue ;;
        *=*)
          key="${line%%=*}"
          key="${key#export }"
          key="$(printf '%s' "$key" | tr -d '[:space:]')"
          eval "export $line" 2>/dev/null || true
          ;;
      esac
    done < "$env_file"
  fi

  local cfg="scripts/seed-pools.staging.config.json"
  local tmp_out
  tmp_out="$(mktemp -t prepush-stg-dry.XXXXXX)"

  info "running: npx tsx scripts/seed-pools.ts --dry-run --config $cfg"
  set +e
  (cd "$REPO_ROOT" && npx --yes tsx scripts/seed-pools.ts --dry-run --config "$cfg") >"$tmp_out" 2>&1
  local rc=$?
  set -u

  cat "$tmp_out" >> "$LOG_PATH"
  if [ "$QUIET" -eq 0 ]; then
    cat "$tmp_out"
  fi

  if [ $rc -ne 0 ]; then
    fail "seed-pools dry-run exited $rc — captured output above.
        If the error is 'placeholder zero detected', edit seed-pools.staging.config.json
        and replace the four 0x000...000 fields with real staging addresses."
    rm -f "$tmp_out"
    PHASE4_STATUS=1
    return
  fi

  # Verify the plan: 15 deposits / $800 MockUSDC
  local has_15=0 has_800=0
  if grep -Eq "(^|[^0-9])15([^0-9]|$).*deposit|deposit.*(^|[^0-9])15([^0-9]|$)" "$tmp_out"; then
    has_15=1
  fi
  if grep -Eq "(^|[^0-9])800(\.0+)?([^0-9]|$)" "$tmp_out"; then
    has_800=1
  fi

  if [ $has_15 -eq 1 ] && [ $has_800 -eq 1 ]; then
    ok "dry-run plan matches expected: 15 deposits / \$800 MockUSDC"
  elif [ $has_15 -eq 1 ]; then
    warn "dry-run shows 15 deposits but \$800 not detected verbatim — review captured output"
  else
    fail "dry-run output did not show expected 15 deposits / \$800 plan. See $LOG_PATH."
    failed=1
  fi

  rm -f "$tmp_out"
  PHASE4_STATUS=$failed
  if [ $failed -eq 0 ]; then
    ok "Phase 4 PASS"
  else
    fail "Phase 4 FAIL"
  fi
}

# ── Verdict block ────────────────────────────────────────────────────────────
verdict() {
  local p1 p2 p3 p4 verdict_text verdict_color exit_code

  if [ $PHASE1_STATUS -eq 0 ]; then p1="PASS"; else p1="FAIL"; fi
  if [ $PHASE2_STATUS -eq 0 ]; then p2="PASS"; else p2="FAIL"; fi
  if [ $PHASE3_WARN_COUNT -eq 0 ]; then
    p3="OK (0 warnings)"
  else
    p3="$PHASE3_WARN_COUNT warning(s)"
  fi
  if [ $PHASE4_STATUS -eq 0 ]; then p4="PASS"; else p4="FAIL"; fi

  local hard_failed=0
  if [ $PHASE1_STATUS -ne 0 ] || [ $PHASE2_STATUS -ne 0 ] || [ $PHASE4_STATUS -ne 0 ]; then
    hard_failed=1
  fi

  if [ $hard_failed -eq 1 ]; then
    verdict_text="NOT READY"
    verdict_color="$RED$BLD"
    exit_code=1
  elif [ $PHASE3_WARN_COUNT -gt 0 ]; then
    verdict_text="PUSH WITH WARNINGS"
    verdict_color="$YEL$BLD"
    exit_code=2
  else
    verdict_text="READY"
    verdict_color="$GRN$BLD"
    exit_code=0
  fi

  emit_loud ""
  emit_loud "${BLD}+----------------------------------------------+${RST}"
  emit_loud "${BLD}|     zBase pre-push smoke verdict (STAGING)   |${RST}"
  emit_loud "${BLD}+----------------------------------------------+${RST}"
  emit_loud "$(printf '  Branch:             %s' "$GIT_BRANCH")"
  emit_loud "$(printf '  Date:               %s' "$NOW_HUMAN")"
  emit_loud "$(printf '  Stack:              STAGING (MockUSDC)')"
  emit_loud "$(printf '  Phase 1 (env+addr): %s' "$p1")"
  emit_loud "$(printf '  Phase 2 (tests):    %s' "$p2")"
  emit_loud "$(printf '  Phase 3 (balance):  %s' "$p3")"
  emit_loud "$(printf '  Phase 4 (dryrun):   %s' "$p4")"
  emit_loud "${BLD}+----------------------------------------------+${RST}"
  emit_loud "$(printf '  VERDICT:            %s%s%s' "$verdict_color" "$verdict_text" "$RST")"
  emit_loud "${BLD}+----------------------------------------------+${RST}"
  emit_loud ""
  emit_loud "Full log: $LOG_PATH"
  emit_loud ""

  return $exit_code
}

# ── Main ─────────────────────────────────────────────────────────────────────
emit "pre-push-smoke-staging run starting at $NOW_HUMAN"
emit "log: $LOG_PATH"
emit "flags: quiet=$QUIET"

phase1
if [ $PHASE1_STATUS -ne 0 ]; then
  warn "Phase 1 failed — skipping Phases 2-4 (they depend on env/addresses)"
  PHASE2_STATUS=1
  PHASE4_STATUS=1
  verdict
  exit $?
fi

phase2
phase3
phase4

verdict
exit $?
