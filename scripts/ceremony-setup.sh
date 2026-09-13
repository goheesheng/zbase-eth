#!/usr/bin/env bash
#
# ceremony-setup.sh — zBase note_spend Phase-2 trusted-setup automation (DIY path).
#
# Produces the REAL Groth16 verifier (Verifier_NoteSpend.sol) that replaces the
# mock verifier in UTXOPool.sol. Without this, UTXOPool's VERIFIER accepts ANY
# proof — i.e. the pool is drainable by anyone. This script is the gate between
# "mock that gives money away" and "real pool only its depositors can spend."
#
# Aligns with docs/ceremony/ceremony-runbook-2026-05-31.md:
#   circuit  : circuits/note_spend.circom  (NoteSpend(32,2,2), BN254/Groth16)
#   Phase 1  : powersOfTau28_hez_final_18.ptau  (community, reused — NEVER DIY)
#   Phase 2  : circuit-specific, ≥1 honest contributor of N makes it safe
#   tooling  : snarkjs 0.7.6 + circom + circomlib
#
# This is the OFFLINE/DIY path. For a public hosted ceremony with real external
# contributors, prefer PSE DefinitelySetup (ceremony.pse.dev) — see the runbook.
# Use this script to (a) dry-run locally, (b) produce a single-contributor setup,
# or (c) coordinate a manual round-robin where each contributor runs ONE step.
#
# Usage:
#   bash scripts/ceremony-setup.sh init          # compile + ptau + phase-2 init
#   bash scripts/ceremony-setup.sh contribute "Alice" 0001   # one contributor
#   bash scripts/ceremony-setup.sh finalize      # beacon + verify + export verifier
#   bash scripts/ceremony-setup.sh all "solo"    # full single-contributor run (TEST ONLY)
#
# SAFETY: a single-contributor run (`all`) is NOT a trustworthy ceremony — it is
# for pipeline testing only. A real ceremony needs multiple INDEPENDENT
# contributors, ideally via DefinitelySetup, each destroying their entropy.

set -euo pipefail

# ── Pinned, verifiable constants ─────────────────────────────────────────────
CIRCUIT="circuits/note_spend.circom"
# Frozen source hash from CIRCUIT_FROZEN_FOR_AUDIT.md — the ceremony MUST run
# against this exact source. Any drift invalidates the output.
FROZEN_SHA256="1211d4971de6e1b157e78565275ed8f0d8e7f68304b8b1b69696014b4a352266"
# Phase-1 Powers of Tau (community Hermez ceremony, hundreds of contributors).
# 2^18 = 262,144 constraints — sized per the runbook for NoteSpend(32,2,2).
# note_spend measured at 35,440 constraints (2026-06-13 dry-run), so _18 fits with
# wide margin (no need for _19). Source migrated 2026-06-13 from the old Hermez S3
# bucket (now 403) to the canonical zkevm GCS mirror listed in the snarkjs README;
# the blake2b below pins the file identity regardless of host.
PTAU_FILE="powersOfTau28_hez_final_18.ptau"
PTAU_URL="https://storage.googleapis.com/zkevm/ptau/${PTAU_FILE}"
# Published blake2b hash for powersOfTau28_hez_final_18.ptau, pinned from the
# snarkjs README Powers-of-Tau table (github.com/iden3/snarkjs), cross-verified
# 2026-06-13 against two independent fetches. blake2b, 128 hex chars. The script
# compares the downloaded ptau's b2sum to this; a mismatch aborts (possible tamper).
PTAU_BLAKE2B="7e6a9c2e5f05179ddfc923f38f917c9e6831d16922a902b0b4758b8e79c2ab8a81bb5f29952e16ee6c5067ed044d7857b5de120a90704c1d3b637fd94b95b13e"

BUILD="build/ceremony"
SNARKJS="npx snarkjs"

mkdir -p "$BUILD"

# ── Helpers ──────────────────────────────────────────────────────────────────
say() { printf "\033[1;36m[ceremony]\033[0m %s\n" "$*"; }
die() { printf "\033[1;31m[ceremony] ERROR:\033[0m %s\n" "$*" >&2; exit 1; }

check_frozen() {
  command -v shasum >/dev/null || die "shasum not found"
  local got
  got=$(shasum -a 256 "$CIRCUIT" | awk '{print $1}')
  [ "$got" = "$FROZEN_SHA256" ] || die "circuit hash drift!
  expected (frozen): $FROZEN_SHA256
  got:               $got
  The circuit changed since the freeze. Re-freeze (CIRCUIT_FROZEN_FOR_AUDIT.md)
  and re-confirm BEFORE running a ceremony, or the output is worthless."
  say "circuit matches frozen hash ✓ ($FROZEN_SHA256)"
}

check_tooling() {
  command -v node >/dev/null || die "node not found (need ≥18)"
  if ! command -v circom >/dev/null; then
    die "circom not on PATH. Install the pinned version:
      cargo install --git https://github.com/iden3/circom --tag v2.1.9
    (or per docs/ceremony/ceremony-runbook-2026-05-31.md §1 for the exact pin)."
  fi
  if [ ! -f node_modules/circomlib/circuits/poseidon.circom ]; then
    die "circomlib not installed. Run: npm i circomlib@2  (the circuit includes
      ../node_modules/circomlib/circuits/{poseidon,bitify,comparators}.circom)."
  fi
  say "tooling present: $(circom --version), snarkjs $($SNARKJS --version 2>/dev/null | head -1)"
}

get_ptau() {
  if [ -f "$BUILD/$PTAU_FILE" ]; then
    say "ptau already present: $BUILD/$PTAU_FILE"
  else
    say "downloading Phase-1 ptau (community, reused) — $PTAU_FILE"
    curl -fL --retry 3 -o "$BUILD/$PTAU_FILE" "$PTAU_URL" || die "ptau download failed"
  fi
  # SAFETY: verify the ptau is a valid Powers-of-Tau transcript. This catches a
  # tampered/corrupted file. ALSO compare the blake2b hash to the published value
  # in github.com/iden3/snarkjs README (set PTAU_BLAKE2B above) before trusting it.
  say "verifying ptau transcript (snarkjs powersoftau verify)…"
  $SNARKJS powersoftau verify "$BUILD/$PTAU_FILE" || die "ptau failed verification — DO NOT USE"
  # blake2b is the file-identity check that pins us to the EXACT canonical ptau
  # (snarkjs powersoftau verify above only checks transcript structure, not identity).
  # Compute blake2b with whatever tool exists; b2sum is absent on stock macOS, so
  # fall back to openssl. If NO blake2b tool is available we FAIL CLOSED on a real
  # run — silently skipping the pin would defeat the whole point. (review P1, 2026-06-13)
  local got=""
  if command -v b2sum >/dev/null; then
    got=$(b2sum "$BUILD/$PTAU_FILE" | awk '{print $1}')
  elif command -v openssl >/dev/null && openssl dgst -blake2b512 /dev/null >/dev/null 2>&1; then
    got=$(openssl dgst -blake2b512 "$BUILD/$PTAU_FILE" | awk '{print $NF}')
  fi
  if [ -z "$got" ]; then
    if [ "${CEREMONY_DRYRUN:-0}" = "1" ]; then
      say "⚠️  DRY-RUN: no blake2b tool (b2sum/openssl-blake2b512) — skipping ptau hash pin."
    else
      die "no blake2b tool available (need b2sum or openssl with blake2b512) to verify the
  ptau against its pinned hash. On macOS: 'brew install coreutils' (for b2sum) or use a
  newer openssl. Refusing to run a REAL ceremony without the ptau identity check."
    fi
  else
    say "ptau blake2b: $got"
    case "$PTAU_BLAKE2B" in
      *REPLACE*) say "⚠️  PTAU_BLAKE2B not pinned — compare the above against the snarkjs README and pin it before a real ceremony." ;;
      "$got") say "ptau blake2b matches pinned value ✓" ;;
      *) die "ptau blake2b MISMATCH — expected $PTAU_BLAKE2B, got $got. Possible tamper. STOP." ;;
    esac
  fi
}

cmd_init() {
  check_frozen
  check_tooling
  say "compiling circuit → r1cs"
  circom "$CIRCUIT" --r1cs --wasm --sym -o "$BUILD" -l node_modules
  say "constraint count:"
  $SNARKJS r1cs info "$BUILD/note_spend.r1cs"
  get_ptau
  say "Phase-2 setup: r1cs + ptau → note_spend_0000.zkey (the genesis zkey)"
  $SNARKJS groth16 setup "$BUILD/note_spend.r1cs" "$BUILD/$PTAU_FILE" "$BUILD/note_spend_0000.zkey"
  say "init done. Genesis zkey: $BUILD/note_spend_0000.zkey"
  say "Next: each contributor runs  bash scripts/ceremony-setup.sh contribute \"<name>\" <NNNN>"
  say "      passing the PREVIOUS zkey index. First contributor uses 0001 (consumes 0000)."
}

# contribute <name> <new-index e.g. 0001>
cmd_contribute() {
  local name="${1:?contributor name required}"
  local idx="${2:?new 4-digit index required, e.g. 0001}"
  # Require exactly 4 decimal digits — a non-numeric or short index makes the prev-index
  # arithmetic below misfire (e.g. "000a" silently resolves prev→0000, faking a second
  # genesis-based contribution). (review P2, 2026-06-13)
  [[ "$idx" =~ ^[0-9]{4}$ ]] || die "index must be exactly 4 decimal digits, e.g. 0003 (got: '$idx')"
  [ "$idx" != "0000" ] || die "0000 is the genesis index (made by init); contributors start at 0001"
  local prev; prev=$(printf "%04d" $((10#$idx - 1)))
  local prev_zkey="$BUILD/note_spend_${prev}.zkey"
  local new_zkey="$BUILD/note_spend_${idx}.zkey"
  [ -f "$prev_zkey" ] || die "previous zkey not found: $prev_zkey (run init, or use the correct index)"
  # Entropy source: prefer openssl (universally present); fall back to xxd. Without a
  # guard, a missing xxd silently yields -e="" and snarkjs drops to an interactive
  # prompt that hangs in CI. (review P3, 2026-06-13)
  local entropy=""
  if command -v openssl >/dev/null; then
    entropy=$(openssl rand -hex 64)
  elif command -v xxd >/dev/null; then
    entropy=$(head -c 64 /dev/urandom | xxd -p | tr -d '\n')
  else
    die "no entropy tool (need openssl or xxd) to seed the contribution"
  fi
  say "contributor '$name' adding entropy: $prev_zkey → $new_zkey"
  # -e provides entropy non-interactively; in a real ceremony each contributor
  # supplies their OWN unpredictable entropy and snarkjs discards it after. The
  # security guarantee holds as long as ONE contributor was honest.
  $SNARKJS zkey contribute "$prev_zkey" "$new_zkey" \
    --name="$name" -v -e="$entropy"
  say "contribution recorded: $new_zkey"
  say "Pass $new_zkey to the next contributor (index $(printf "%04d" $((10#$idx + 1))))."
}

# finalize <last-index e.g. 0015>
cmd_finalize() {
  local last; last="${1:?last contributor index required, e.g. 0015}"
  local last_zkey="$BUILD/note_spend_${last}.zkey"
  local final_zkey="$BUILD/note_spend_final.zkey"
  [ -f "$last_zkey" ] || die "last zkey not found: $last_zkey"

  # ── Beacon selection ────────────────────────────────────────────────────────
  # The beacon is a PUBLIC value that was UNPREDICTABLE at the time every
  # contributor added their entropy. Best practice (Semaphore, Zcash): commit
  # PUBLICLY to a FUTURE Base/Ethereum block height in the ceremony README BEFORE
  # that block exists, then after it is mined feed its block hash here. The high
  # iteration count (10 → 2^10 hash iterations) stops a block proposer from
  # grinding a favorable hash. See docs/ceremony/ceremony-runbook-2026-05-31.md §5.
  #
  # Real run:  CEREMONY_BEACON_HEX=<0x-stripped 64-hex block hash> bash ... finalize <NNNN>
  # Dry-run:   CEREMONY_DRYRUN=1 ...  (allows the throwaway test beacon below)
  local TEST_BEACON="0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"
  local BEACON="${CEREMONY_BEACON_HEX:-}"
  if [ -z "$BEACON" ]; then
    if [ "${CEREMONY_DRYRUN:-0}" = "1" ]; then
      say "⚠️  DRY-RUN: using the throwaway TEST beacon (NOT trustworthy — pipeline test only)"
      BEACON="$TEST_BEACON"
    else
      die "no beacon set. A real finalization MUST use a pre-announced public block hash.
  Set CEREMONY_BEACON_HEX=<64-hex Base/Ethereum block hash for the block you
  publicly pre-committed to in the ceremony README>, e.g.
    CEREMONY_BEACON_HEX=\$(cast block <N> --rpc-url <base-rpc> --json | jq -r .hash | sed 's/^0x//')
  Or, for a TOOLCHAIN dry-run only (throwaway key), pass CEREMONY_DRYRUN=1."
    fi
  fi
  # Guard: never let the throwaway test beacon ship a real ceremony.
  if [ "$BEACON" = "$TEST_BEACON" ] && [ "${CEREMONY_DRYRUN:-0}" != "1" ]; then
    die "refusing to finalize a real ceremony with the throwaway TEST beacon. Set a real
  CEREMONY_BEACON_HEX (pre-announced block hash), or CEREMONY_DRYRUN=1 for a dry-run."
  fi
  # Validate the beacon is exactly a 256-bit hex value (a block hash, 0x-stripped).
  # A short/garbled beacon would silently produce a final key whose claimed source
  # ("block N hash") can't be reproduced by a verifier. (review P2, 2026-06-13)
  if [ "${CEREMONY_DRYRUN:-0}" != "1" ] && ! [[ "$BEACON" =~ ^[0-9a-fA-F]{64}$ ]]; then
    die "CEREMONY_BEACON_HEX must be exactly 64 hex chars (a 256-bit block hash, no 0x). Got: '$BEACON'"
  fi
  # Iteration exponent: 2^20 ≈ 1M iterated hashes. 2^10 (the prior value) is grindable
  # by a block proposer; Base's single sequencer makes that worse — prefer an ETHEREUM
  # L1 block hash for the real beacon, with a high exponent. (review P2, 2026-06-13)
  local BEACON_ITERS=20
  say "applying random beacon (iterations=2^${BEACON_ITERS}) → final zkey  [beacon ${BEACON:0:12}…]"
  $SNARKJS zkey beacon "$last_zkey" "$final_zkey" "$BEACON" "$BEACON_ITERS" -n="zBase A.1 final beacon"
  say "verifying the full transcript (r1cs + ptau + final zkey)…"
  $SNARKJS zkey verify "$BUILD/note_spend.r1cs" "$BUILD/$PTAU_FILE" "$final_zkey" \
    || die "final zkey FAILED verification — ceremony output is invalid"
  say "exporting verification key + Solidity verifier"
  $SNARKJS zkey export verificationkey "$final_zkey" "$BUILD/note_spend_vkey.json"
  $SNARKJS zkey export solidityverifier "$final_zkey" "$BUILD/Verifier_NoteSpend.sol"
  say "✓ DONE."
  say "  Proving key:  $final_zkey"
  say "  Verifier sol: $BUILD/Verifier_NoteSpend.sol"
  say "Next: deploy Verifier_NoteSpend.sol, set UTXOPool.VERIFIER to its address,"
  say "      remove the mock/unsafeTestMode path, then deploy to mainnet."
  say "See docs/release/mainnet-deploy-checklist.md."
}

# all <name> — single-contributor full run (TEST ONLY, NOT a real ceremony)
cmd_all() {
  local name="${1:-solo-test}"
  say "⚠️  SINGLE-CONTRIBUTOR run — TEST/dry-run only, NOT a trustworthy ceremony."
  # Force dry-run mode so cmd_finalize accepts the throwaway test beacon. A REAL
  # ceremony never uses `all`: it runs init → N independent `contribute` → finalize
  # with a real CEREMONY_BEACON_HEX. This guarantees the test beacon can ONLY ever
  # appear in a throwaway single-contributor run.
  #
  # NOTE: a function-LOCAL var (not `export`) — it is visible to the cmd_* functions
  # called below (same shell), but does NOT leak into the process environment, so a
  # later separate `bash ceremony-setup.sh finalize` invocation cannot inherit a stale
  # dry-run flag and silently apply the test beacon to a real run. (review P1, 2026-06-13)
  local CEREMONY_DRYRUN=1
  cmd_init
  cmd_contribute "$name" 0001
  cmd_finalize 0001
}

case "${1:-}" in
  init)       cmd_init ;;
  contribute) shift; cmd_contribute "$@" ;;
  finalize)   shift; cmd_finalize "$@" ;;
  all)        shift; cmd_all "$@" ;;
  *) cat <<EOF
zBase note_spend Phase-2 ceremony automation.

  init                         compile circuit + fetch/verify ptau + phase-2 init
  contribute "<name>" <NNNN>   one contributor adds entropy (NNNN = new index)
  finalize <NNNN>              beacon + verify + export Verifier_NoteSpend.sol
  all "<name>"                 single-contributor full run (TEST ONLY)

Real ceremony: prefer PSE DefinitelySetup (ceremony.pse.dev) with ≥15 independent
contributors. See docs/ceremony/ceremony-runbook-2026-05-31.md.
EOF
  ;;
esac
