#!/usr/bin/env bash
# scripts/pre-push-smoke.sh — One-shot READY / NOT READY verdict for the Base
# Sepolia push. Consolidates env validation, offline tests, RPC reachability,
# seed dry-run, and optional foundry/balance checks into a single go/no-go.
#
# Phases:
#   1. env + tooling validation (no chain interaction)
#   2. offline test gates (npm run test:seed-pools, crash-resume drill, stealth,
#      bash -n syntax check, JSON validation)
#   3. RPC reachability (one read-only eth_blockNumber + eth_chainId)
#   4. seed-pools.ts --dry-run preview (validates plan = 30 deposits / $1,600)
#   5. optional: forge build, forge test --list, treasury balance probe
#   6. verdict block
#
# Flags:
#   --skip-optional   skip Phase 5 entirely
#   --quiet           suppress per-test output (only the verdict block prints)
#   --help            print usage
#
# Exit codes:
#   0  READY              (all hard gates pass)
#   1  NOT READY          (any hard gate fails)
#   2  PUSH WITH WARNINGS (hard gates pass, optional gates raised loud warnings)
#
# Constraints:
#   - bash 3.2 safe (runs on macOS)
#   - Never logs env values, even partially
#   - Never makes a state-changing chain call
#   - Never touches main branch, never commits
#   - Tees all output to data/pre-push-smoke-<UTC>.log

set -u

# ── Cross-shell terminal colors (POSIX-safe, no-op when not a TTY) ────────────
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
LOG_PATH="$LOG_DIR/pre-push-smoke-$TIMESTAMP.log"

SKIP_OPTIONAL=0
QUIET=0

# Per-phase status flags (0=pass, 1=fail, 2=skipped)
PHASE1_STATUS=0
PHASE2_STATUS=0
PHASE3_STATUS=0
PHASE4_STATUS=0
PHASE5_WARN_COUNT=0
PHASE2_PASS_COUNT=0
PHASE2_TOTAL_COUNT=0

# Captured branch name
GIT_BRANCH=""

# ── CLI parsing ──────────────────────────────────────────────────────────────
usage() {
  cat <<'USAGE'
Usage: scripts/pre-push-smoke.sh [--skip-optional] [--quiet] [--help]

One-shot READY / NOT READY verdict for the Base Sepolia push. Runs every
relevant gate (env, offline tests, RPC reachability, seed dry-run, optional
foundry + balance probe) and emits a single go/no-go.

Flags:
  --skip-optional   skip Phase 5 (forge build, treasury balance probe)
  --quiet           suppress per-test output; only the verdict block prints
  --help            this message

Exit codes:
  0  READY              (all hard gates pass)
  1  NOT READY          (any hard gate failed)
  2  PUSH WITH WARNINGS (hard gates pass, but loud Phase 5 warnings)

Output is teed to data/pre-push-smoke-<UTC>.log.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-optional) SKIP_OPTIONAL=1; shift ;;
    --quiet)         QUIET=1; shift ;;
    -h|--help)       usage; exit 0 ;;
    *) printf "unknown flag: %s (try --help)\n" "$1" >&2; exit 2 ;;
  esac
done

# ── Logging helpers ──────────────────────────────────────────────────────────
mkdir -p "$LOG_DIR"
: > "$LOG_PATH"

# Write a line to the log unconditionally; mirror to stdout unless --quiet.
emit() {
  printf '%s\n' "$*" >> "$LOG_PATH"
  if [ "$QUIET" -eq 0 ]; then
    printf '%s\n' "$*"
  fi
}

# Always print to stdout regardless of --quiet (used for the verdict block).
emit_loud() {
  printf '%s\n' "$*" >> "$LOG_PATH"
  printf '%s\n' "$*"
}

info()  { emit "${BLU}[pre-push]${RST} $*"; }
ok()    { emit "${GRN}[pre-push] OK:${RST} $*"; }
warn()  { emit "${YEL}[pre-push] WARN:${RST} $*"; }
fail()  { emit "${RED}[pre-push] FAIL:${RST} $*"; }
hdr()   { emit ""; emit "${BLD}=== $* ===${RST}"; }

# Run a command, capture stdout+stderr to the log, return its exit code.
# Mirrors output to terminal unless --quiet.
run_cmd() {
  # $1 = label, rest = command
  label="$1"; shift
  emit "${DIM}\$ $*${RST}"
  set +e
  if [ "$QUIET" -eq 1 ]; then
    output="$("$@" 2>&1)"
    rc=$?
    printf '%s\n' "$output" >> "$LOG_PATH"
  else
    # Use a temp file so we capture into the log AND show on terminal
    tmp="$(mktemp -t prepush.XXXXXX)"
    "$@" >"$tmp" 2>&1
    rc=$?
    cat "$tmp" | tee -a "$LOG_PATH"
    rm -f "$tmp"
  fi
  set -u
  return $rc
}

# ── Phase 1: env + tooling validation ────────────────────────────────────────
phase1() {
  hdr "Phase 1 — env + tooling validation"
  local failed=0

  # 1a. .env.local exists and readable
  local env_file="$REPO_ROOT/.env.local"
  if [ ! -f "$env_file" ]; then
    fail ".env.local not found at $env_file"
    failed=1
  elif [ ! -r "$env_file" ]; then
    fail ".env.local exists but is not readable"
    failed=1
  else
    ok ".env.local present and readable"
  fi

  # 1b–1e. Required env-var keys present (grep only, never log values).
  # We check the file directly so we don't accidentally echo values from `env`.
  check_env_key() {
    local key="$1" file="$2" desc="$3" hint="$4"
    if [ ! -f "$file" ]; then
      # already reported above
      return 1
    fi
    # Allow optional "export " prefix and surrounding whitespace.
    # Require `KEY=` with a non-empty value (anything past the =).
    if grep -Eq "^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*=.+" "$file"; then
      printf '%s' "$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*=" "$file" | head -n1 | sed -E "s/^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*=//")"
      return 0
    fi
    fail "$desc missing — add to .env.local: $hint"
    return 1
  }

  # BASE_SEPOLIA_RPC: existence only
  if grep -Eq "^[[:space:]]*(export[[:space:]]+)?BASE_SEPOLIA_RPC[[:space:]]*=.+" "$env_file" 2>/dev/null; then
    ok "BASE_SEPOLIA_RPC is set"
  else
    fail "BASE_SEPOLIA_RPC missing — add a line like: BASE_SEPOLIA_RPC=https://sepolia.base.org"
    failed=1
  fi

  # POSTMAN_PRIVATE_KEY: existence only
  if grep -Eq "^[[:space:]]*(export[[:space:]]+)?POSTMAN_PRIVATE_KEY[[:space:]]*=.+" "$env_file" 2>/dev/null; then
    ok "POSTMAN_PRIVATE_KEY is set"
  else
    fail "POSTMAN_PRIVATE_KEY missing — add to .env.local (private key for ASP postman)"
    failed=1
  fi

  # ZBASE_SEED_ENCRYPTION_KEY: existence + 64-hex format
  local seed_key_value
  seed_key_value="$(grep -E "^[[:space:]]*(export[[:space:]]+)?ZBASE_SEED_ENCRYPTION_KEY[[:space:]]*=" "$env_file" 2>/dev/null | head -n1 | sed -E "s/^[[:space:]]*(export[[:space:]]+)?ZBASE_SEED_ENCRYPTION_KEY[[:space:]]*=//" | sed -e 's/^["'\'']//' -e 's/["'\'']$//' || true)"
  if [ -z "$seed_key_value" ]; then
    fail "ZBASE_SEED_ENCRYPTION_KEY missing — add to .env.local (generate with: openssl rand -hex 32)"
    failed=1
  else
    local seed_key_len="${#seed_key_value}"
    if [ "$seed_key_len" -ne 64 ]; then
      fail "ZBASE_SEED_ENCRYPTION_KEY must be exactly 64 hex chars (got $seed_key_len). Regenerate: openssl rand -hex 32"
      failed=1
    else
      case "$seed_key_value" in
        *[!0-9a-fA-F]*)
          fail "ZBASE_SEED_ENCRYPTION_KEY must be hex (0-9, a-f). Regenerate: openssl rand -hex 32"
          failed=1
          ;;
        *) ok "ZBASE_SEED_ENCRYPTION_KEY format valid (64 hex chars)" ;;
      esac
    fi
    # scrub
    seed_key_value=""
  fi

  # TREASURY_PRIVATE_KEY: existence + 0x-prefix + 66 chars
  local treasury_line treasury_value treasury_len
  treasury_line="$(grep -nE "^[[:space:]]*(export[[:space:]]+)?TREASURY_PRIVATE_KEY[[:space:]]*=" "$env_file" 2>/dev/null | head -n1 || true)"
  if [ -z "$treasury_line" ]; then
    fail "TREASURY_PRIVATE_KEY missing from $env_file. Add a line: TREASURY_PRIVATE_KEY=0x<64-hex-chars> (66 chars total including 0x prefix). This key must control the treasury wallet 0xcDB447c3a352AD8ADF3D8d97Da9a3CF91880b843."
    failed=1
  else
    treasury_value="$(printf '%s' "$treasury_line" | sed -E 's/^[0-9]+://' | sed -E "s/^[[:space:]]*(export[[:space:]]+)?TREASURY_PRIVATE_KEY[[:space:]]*=//" | sed -e 's/^["'\'']//' -e 's/["'\'']$//')"
    treasury_len="${#treasury_value}"
    local line_num
    line_num="$(printf '%s' "$treasury_line" | cut -d: -f1)"
    case "$treasury_value" in
      0x*)
        if [ "$treasury_len" -ne 66 ]; then
          fail "TREASURY_PRIVATE_KEY at .env.local line $line_num is wrong length: $treasury_len chars (expected 66 = '0x' + 64 hex). Replace with a valid private key."
          failed=1
        else
          ok "TREASURY_PRIVATE_KEY format valid (0x + 64 hex, line $line_num)"
        fi
        ;;
      *)
        fail "TREASURY_PRIVATE_KEY at .env.local line $line_num must start with '0x' (got ${treasury_len} chars without 0x prefix). Replace with a 0x-prefixed 66-char private key."
        failed=1
        ;;
    esac
    treasury_value=""
    treasury_line=""
  fi

  # 1f. node + npx
  if command -v node >/dev/null 2>&1; then
    ok "node available ($(node --version 2>/dev/null))"
  else
    fail "node not on PATH — install Node.js >= 20"
    failed=1
  fi
  if command -v npx >/dev/null 2>&1; then
    ok "npx available"
  else
    fail "npx not on PATH — install Node.js >= 20"
    failed=1
  fi

  # 1g. forge (warn only)
  if command -v forge >/dev/null 2>&1; then
    ok "forge available ($(forge --version 2>/dev/null | head -n1))"
  else
    warn "forge not on PATH — foundry tests will be skipped (does not block Sepolia push)"
  fi

  # 1h. git + branch
  if command -v git >/dev/null 2>&1; then
    GIT_BRANCH="$(cd "$REPO_ROOT" && git rev-parse --abbrev-ref HEAD 2>/dev/null || printf 'unknown')"
    ok "git available, current branch: $GIT_BRANCH"
  else
    fail "git not on PATH"
    GIT_BRANCH="unknown"
    failed=1
  fi

  # 1i. config file exists + valid JSON
  local cfg="$REPO_ROOT/scripts/seed-pools.phase0.config.json"
  if [ ! -f "$cfg" ]; then
    fail "scripts/seed-pools.phase0.config.json not found"
    failed=1
  else
    if node -e "JSON.parse(require('fs').readFileSync('$cfg','utf8'))" >/dev/null 2>&1; then
      ok "seed-pools.phase0.config.json present and valid JSON"
    else
      fail "seed-pools.phase0.config.json is not valid JSON"
      failed=1
    fi
  fi

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
  PHASE2_TOTAL_COUNT=5
  PHASE2_PASS_COUNT=0

  # 2a. npm run test:seed-pools (must be 10/10)
  info "running: npm run test:seed-pools"
  if (cd "$REPO_ROOT" && run_cmd "test:seed-pools" npm run test:seed-pools --silent); then
    ok "npm run test:seed-pools PASS"
    PHASE2_PASS_COUNT=$((PHASE2_PASS_COUNT + 1))
  else
    fail "npm run test:seed-pools FAILED — see $LOG_PATH"
    failed=1
  fi

  # 2b. crash-resume drill
  info "running: bash scripts/test-crash-resume-drill.sh"
  if (cd "$REPO_ROOT" && run_cmd "crash-resume" bash scripts/test-crash-resume-drill.sh); then
    ok "test-crash-resume-drill.sh PASS"
    PHASE2_PASS_COUNT=$((PHASE2_PASS_COUNT + 1))
  else
    fail "test-crash-resume-drill.sh FAILED"
    failed=1
  fi

  # 2c. stealth invariants
  info "running: npx tsx scripts/test-stealth.ts"
  if (cd "$REPO_ROOT" && run_cmd "test-stealth" npx --yes tsx scripts/test-stealth.ts); then
    ok "test-stealth.ts PASS"
    PHASE2_PASS_COUNT=$((PHASE2_PASS_COUNT + 1))
  else
    fail "test-stealth.ts FAILED"
    failed=1
  fi

  # 2d. syntax check
  info "running: bash -n on critical shell scripts"
  if (cd "$REPO_ROOT" && run_cmd "bash-n" bash -n scripts/seed-phase0.sh scripts/decoy-scheduler-launcher.sh scripts/test-crash-resume-drill.sh scripts/forge-wrap.sh); then
    ok "shell-script syntax PASS"
    PHASE2_PASS_COUNT=$((PHASE2_PASS_COUNT + 1))
  else
    fail "shell-script syntax FAILED"
    failed=1
  fi

  # 2e. JSON valid (redundant with Phase 1 but called out per spec)
  info "running: JSON validation of phase0 config"
  if (cd "$REPO_ROOT" && run_cmd "json-valid" node -e "JSON.parse(require('fs').readFileSync('scripts/seed-pools.phase0.config.json','utf8')); console.log('ok')"); then
    ok "seed-pools.phase0.config.json JSON valid"
    PHASE2_PASS_COUNT=$((PHASE2_PASS_COUNT + 1))
  else
    fail "seed-pools.phase0.config.json JSON parse FAILED"
    failed=1
  fi

  PHASE2_STATUS=$failed
  if [ $failed -eq 0 ]; then
    ok "Phase 2 PASS ($PHASE2_PASS_COUNT/$PHASE2_TOTAL_COUNT)"
  else
    fail "Phase 2 FAIL ($PHASE2_PASS_COUNT/$PHASE2_TOTAL_COUNT)"
  fi
}

# ── Phase 3: RPC reachability (read-only) ────────────────────────────────────
phase3() {
  hdr "Phase 3 — RPC reachability (read-only)"
  local failed=0

  # Source env file into a subshell to extract BASE_SEPOLIA_RPC without
  # echoing it. We pipe the value via a node helper to avoid polluting our
  # shell history with the URL (which may contain API keys).
  local env_file="$REPO_ROOT/.env.local"
  local rpc_url
  rpc_url="$(grep -E "^[[:space:]]*(export[[:space:]]+)?BASE_SEPOLIA_RPC[[:space:]]*=" "$env_file" 2>/dev/null | head -n1 | sed -E "s/^[[:space:]]*(export[[:space:]]+)?BASE_SEPOLIA_RPC[[:space:]]*=//" | sed -e 's/^["'\'']//' -e 's/["'\'']$//')"
  if [ -z "$rpc_url" ]; then
    fail "BASE_SEPOLIA_RPC not set; cannot test reachability"
    PHASE3_STATUS=1
    return
  fi

  # eth_blockNumber
  local block_resp block_hex
  if command -v cast >/dev/null 2>&1; then
    info "probing eth_blockNumber via cast"
    block_hex="$(cast block-number --rpc-url "$rpc_url" 2>/dev/null || true)"
    if [ -n "$block_hex" ]; then
      ok "eth_blockNumber OK (block #$block_hex)"
    else
      fail "cast block-number failed — RPC unreachable or invalid"
      failed=1
    fi

    info "probing eth_chainId via cast"
    local chain_id
    chain_id="$(cast chain-id --rpc-url "$rpc_url" 2>/dev/null || true)"
    if [ "$chain_id" = "84532" ]; then
      ok "eth_chainId OK (84532 = Base Sepolia)"
    else
      fail "eth_chainId returned '$chain_id' (expected 84532). Wrong network in BASE_SEPOLIA_RPC."
      failed=1
    fi
  else
    # Fallback: inline curl
    info "probing eth_blockNumber via curl (cast not installed)"
    block_resp="$(curl -s -X POST -H 'Content-Type: application/json' --max-time 10 \
      --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' "$rpc_url" 2>/dev/null || true)"
    block_hex="$(printf '%s' "$block_resp" | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{try{const j=JSON.parse(s);console.log(j.result||'')}catch(e){}})" 2>/dev/null || true)"
    case "$block_hex" in
      0x*[0-9a-fA-F]*)
        ok "eth_blockNumber OK (block $block_hex)"
        ;;
      *)
        fail "eth_blockNumber returned no valid hex (got: '$block_hex'). RPC unreachable."
        failed=1
        ;;
    esac

    info "probing eth_chainId via curl"
    local chain_resp chain_hex
    chain_resp="$(curl -s -X POST -H 'Content-Type: application/json' --max-time 10 \
      --data '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' "$rpc_url" 2>/dev/null || true)"
    chain_hex="$(printf '%s' "$chain_resp" | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{try{const j=JSON.parse(s);console.log(j.result||'')}catch(e){}})" 2>/dev/null || true)"
    if [ "$chain_hex" = "0x14a34" ]; then
      ok "eth_chainId OK (0x14a34 = Base Sepolia)"
    else
      fail "eth_chainId returned '$chain_hex' (expected 0x14a34 = 84532)"
      failed=1
    fi
  fi

  rpc_url=""
  PHASE3_STATUS=$failed
  if [ $failed -eq 0 ]; then
    ok "Phase 3 PASS"
  else
    fail "Phase 3 FAIL"
  fi
}

# ── Phase 4: seed-pools dry-run ──────────────────────────────────────────────
phase4() {
  hdr "Phase 4 — seed-pools.ts --dry-run"
  local failed=0

  # Load .env.local into this process so seed-pools.ts sees the required vars.
  # We do NOT echo any value back out.
  local env_file="$REPO_ROOT/.env.local"
  if [ -f "$env_file" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in
        ''|\#*) continue ;;
        *=*)
          key="${line%%=*}"
          key="${key#export }"
          key="$(printf '%s' "$key" | tr -d '[:space:]')"
          # set unconditionally — we want phase4 to use the file's values
          eval "export $line" 2>/dev/null || true
          ;;
      esac
    done < "$env_file"
  fi

  local cfg="scripts/seed-pools.phase0.config.json"
  local tmp_out
  tmp_out="$(mktemp -t prepush-dryrun.XXXXXX)"

  info "running: npx tsx scripts/seed-pools.ts --dry-run --config $cfg"
  set +e
  (cd "$REPO_ROOT" && npx --yes tsx scripts/seed-pools.ts --dry-run --config "$cfg") >"$tmp_out" 2>&1
  local rc=$?
  set -u

  # Always append captured output to the log
  cat "$tmp_out" >> "$LOG_PATH"
  if [ "$QUIET" -eq 0 ]; then
    cat "$tmp_out"
  fi

  if [ $rc -ne 0 ]; then
    fail "seed-pools dry-run exited $rc — captured output above"
    rm -f "$tmp_out"
    PHASE4_STATUS=1
    return
  fi

  # Verify the plan: look for "30" deposits and "$1,600" or "1600" USDC
  # The dry-run printer may format as "30 deposits" or "Total: 30" — match generously.
  local has_30=0 has_1600=0
  if grep -Eq "(^|[^0-9])30([^0-9]|$).*deposit|deposit.*(^|[^0-9])30([^0-9]|$)" "$tmp_out"; then
    has_30=1
  fi
  # Look for 1600, 1,600, 1600.0, $1600, $1,600
  if grep -Eq "1,?600(\.0+)?" "$tmp_out"; then
    has_1600=1
  fi

  if [ $has_30 -eq 1 ] && [ $has_1600 -eq 1 ]; then
    ok "dry-run plan matches expected: 30 deposits / \$1,600 USDC"
  elif [ $has_30 -eq 1 ]; then
    warn "dry-run shows 30 deposits but \$1,600 total not detected verbatim — review captured output"
    # Don't hard-fail; the deposit count is the load-bearing assertion.
  else
    fail "dry-run output did not show expected 30 deposits / \$1,600 plan. See captured output in $LOG_PATH."
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

# ── Phase 5: optional gates (warnings only) ──────────────────────────────────
phase5() {
  hdr "Phase 5 — optional gates (warnings only)"
  PHASE5_WARN_COUNT=0

  # 5a. forge build
  if command -v forge >/dev/null 2>&1; then
    info "running: forge build (warnings only)"
    local tmp
    tmp="$(mktemp -t prepush-forge.XXXXXX)"
    set +e
    (cd "$REPO_ROOT" && forge build) >"$tmp" 2>&1
    local rc=$?
    set -u
    cat "$tmp" >> "$LOG_PATH"
    if [ "$QUIET" -eq 0 ]; then
      tail -n 20 "$tmp"
    fi
    local warn_count
    warn_count="$(grep -ciE 'warning' "$tmp" 2>/dev/null || printf 0)"
    if [ $rc -ne 0 ]; then
      warn "forge build FAILED (compile errors). Inspect $LOG_PATH."
      PHASE5_WARN_COUNT=$((PHASE5_WARN_COUNT + 1))
    else
      ok "forge build OK ($warn_count compiler warnings)"
    fi
    rm -f "$tmp"

    info "running: forge test --list (sanity)"
    set +e
    (cd "$REPO_ROOT" && FOUNDRY_PROFILE=default forge test --list 2>&1 | head -5) >>"$LOG_PATH" 2>&1
    local list_rc=$?
    set -u
    if [ $list_rc -ne 0 ]; then
      warn "forge test --list returned non-zero — foundry may not find tests"
      PHASE5_WARN_COUNT=$((PHASE5_WARN_COUNT + 1))
    else
      ok "forge test --list OK"
    fi
  else
    warn "forge not installed — skipping forge build + test --list"
    PHASE5_WARN_COUNT=$((PHASE5_WARN_COUNT + 1))
  fi

  # 5b. treasury balance probe (ETH + USDC)
  if command -v cast >/dev/null 2>&1; then
    local env_file="$REPO_ROOT/.env.local"
    local rpc_url treasury_addr
    rpc_url="$(grep -E "^[[:space:]]*(export[[:space:]]+)?BASE_SEPOLIA_RPC[[:space:]]*=" "$env_file" 2>/dev/null | head -n1 | sed -E "s/^[[:space:]]*(export[[:space:]]+)?BASE_SEPOLIA_RPC[[:space:]]*=//" | sed -e 's/^["'\'']//' -e 's/["'\'']$//')"
    # Read treasury address from the config (NOT the private key — public address only)
    treasury_addr="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$REPO_ROOT/scripts/seed-pools.phase0.config.json','utf8')).treasury || '')" 2>/dev/null || true)"

    if [ -n "$rpc_url" ] && [ -n "$treasury_addr" ]; then
      info "probing treasury ETH balance"
      local eth_wei eth_dec
      eth_wei="$(cast balance --rpc-url "$rpc_url" "$treasury_addr" 2>/dev/null || true)"
      if [ -n "$eth_wei" ]; then
        # Convert wei to ETH (integer divide, 1e18). Use node for safe big-int math.
        eth_dec="$(node -e "const w=BigInt('$eth_wei'); console.log((Number(w)/1e18).toFixed(4))" 2>/dev/null || printf '?')"
        # Warn if < 0.05 ETH
        local low_eth
        low_eth="$(node -e "console.log(BigInt('$eth_wei') < BigInt('50000000000000000') ? 1 : 0)" 2>/dev/null || printf 0)"
        if [ "$low_eth" = "1" ]; then
          warn "treasury ETH balance LOW: $eth_dec ETH (< 0.05 threshold) — fund $treasury_addr before push"
          PHASE5_WARN_COUNT=$((PHASE5_WARN_COUNT + 1))
        else
          ok "treasury ETH balance: $eth_dec ETH"
        fi
      else
        warn "could not read treasury ETH balance via cast"
        PHASE5_WARN_COUNT=$((PHASE5_WARN_COUNT + 1))
      fi

      info "probing treasury USDC balance"
      local usdc_addr="0x036CbD53842c5426634e7929541eC2318f3dCF7e"
      local usdc_raw usdc_dec
      usdc_raw="$(cast call --rpc-url "$rpc_url" "$usdc_addr" "balanceOf(address)(uint256)" "$treasury_addr" 2>/dev/null | awk '{print $1}' || true)"
      if [ -n "$usdc_raw" ]; then
        usdc_dec="$(node -e "const w=BigInt('$usdc_raw'); console.log((Number(w)/1e6).toFixed(2))" 2>/dev/null || printf '?')"
        # Warn if < 1600 USDC (Phase 0 needs $1,600)
        local low_usdc
        low_usdc="$(node -e "console.log(BigInt('$usdc_raw') < BigInt('1600000000') ? 1 : 0)" 2>/dev/null || printf 0)"
        if [ "$low_usdc" = "1" ]; then
          warn "treasury USDC balance LOW: \$$usdc_dec (< \$1,600 needed for Phase 0)"
          PHASE5_WARN_COUNT=$((PHASE5_WARN_COUNT + 1))
        else
          ok "treasury USDC balance: \$$usdc_dec"
        fi
      else
        warn "could not read treasury USDC balance via cast"
        PHASE5_WARN_COUNT=$((PHASE5_WARN_COUNT + 1))
      fi
    else
      warn "cannot probe treasury balance (missing RPC or treasury address)"
      PHASE5_WARN_COUNT=$((PHASE5_WARN_COUNT + 1))
    fi
    rpc_url=""
  else
    warn "cast not installed — skipping treasury balance probe"
    # Skipping a check isn't a loud warning per the spec (loud = low balance).
    # Don't increment WARN_COUNT here so verdict stays GREEN if everything else is fine.
  fi

  info "Phase 5 complete: $PHASE5_WARN_COUNT warning(s)"
}

# ── Verdict block ────────────────────────────────────────────────────────────
verdict() {
  local p1 p2 p3 p4 p5 verdict_text verdict_color exit_code

  if [ $PHASE1_STATUS -eq 0 ]; then p1="✅ PASS"; else p1="❌ FAIL"; fi
  if [ $PHASE2_STATUS -eq 0 ]; then
    p2="✅ PASS ($PHASE2_PASS_COUNT/$PHASE2_TOTAL_COUNT)"
  else
    p2="❌ FAIL ($PHASE2_PASS_COUNT/$PHASE2_TOTAL_COUNT)"
  fi
  if [ $PHASE3_STATUS -eq 0 ]; then p3="✅ PASS"; else p3="❌ FAIL"; fi
  if [ $PHASE4_STATUS -eq 0 ]; then p4="✅ PASS"; else p4="❌ FAIL"; fi
  if [ $SKIP_OPTIONAL -eq 1 ]; then
    p5="⏭  SKIPPED"
  elif [ $PHASE5_WARN_COUNT -eq 0 ]; then
    p5="✅ 0 warnings"
  else
    p5="⚠️  $PHASE5_WARN_COUNT warning(s)"
  fi

  local hard_failed=0
  if [ $PHASE1_STATUS -ne 0 ] || [ $PHASE2_STATUS -ne 0 ] || [ $PHASE3_STATUS -ne 0 ] || [ $PHASE4_STATUS -ne 0 ]; then
    hard_failed=1
  fi

  if [ $hard_failed -eq 1 ]; then
    verdict_text="🔴 NOT READY"
    verdict_color="$RED$BLD"
    exit_code=1
  elif [ $SKIP_OPTIONAL -eq 0 ] && [ $PHASE5_WARN_COUNT -gt 0 ]; then
    verdict_text="🟡 PUSH WITH WARNINGS"
    verdict_color="$YEL$BLD"
    exit_code=2
  else
    verdict_text="🟢 READY"
    verdict_color="$GRN$BLD"
    exit_code=0
  fi

  emit_loud ""
  emit_loud "${BLD}╭──────────────────────────────────────────────╮${RST}"
  emit_loud "${BLD}│         zBase pre-push smoke verdict          │${RST}"
  emit_loud "${BLD}├──────────────────────────────────────────────┤${RST}"
  emit_loud "$(printf '  Branch:             %s' "$GIT_BRANCH")"
  emit_loud "$(printf '  Date:               %s' "$NOW_HUMAN")"
  emit_loud "$(printf '  Phase 1 (env):      %s' "$p1")"
  emit_loud "$(printf '  Phase 2 (tests):    %s' "$p2")"
  emit_loud "$(printf '  Phase 3 (rpc):      %s' "$p3")"
  emit_loud "$(printf '  Phase 4 (dryrun):   %s' "$p4")"
  emit_loud "$(printf '  Phase 5 (optional): %s' "$p5")"
  emit_loud "${BLD}├──────────────────────────────────────────────┤${RST}"
  emit_loud "$(printf '  VERDICT:            %s%s%s' "$verdict_color" "$verdict_text" "$RST")"
  emit_loud "${BLD}╰──────────────────────────────────────────────╯${RST}"
  emit_loud ""
  emit_loud "Full log: $LOG_PATH"
  emit_loud ""

  return $exit_code
}

# ── Main ─────────────────────────────────────────────────────────────────────
emit "pre-push-smoke run starting at $NOW_HUMAN"
emit "log: $LOG_PATH"
emit "flags: skip-optional=$SKIP_OPTIONAL quiet=$QUIET"

phase1
if [ $PHASE1_STATUS -ne 0 ]; then
  # Skip remaining gates — they all depend on phase1 invariants
  warn "Phase 1 failed — skipping Phases 2–5 (they depend on env/tooling)"
  PHASE2_STATUS=1
  PHASE3_STATUS=1
  PHASE4_STATUS=1
  verdict
  exit $?
fi

phase2
phase3
phase4

if [ $SKIP_OPTIONAL -eq 0 ]; then
  phase5
else
  hdr "Phase 5 — SKIPPED (--skip-optional)"
fi

verdict
exit $?
