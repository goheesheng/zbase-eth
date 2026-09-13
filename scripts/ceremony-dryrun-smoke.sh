#!/usr/bin/env bash
#
# ceremony-dryrun-smoke.sh — end-to-end TOOLCHAIN smoke for the note_spend
# Phase-2 trusted setup. Runbook §3.3–3.4 (docs/ceremony/ceremony-runbook-2026-05-31.md).
#
# ┌─────────────────────────────────────────────────────────────────────────┐
# │  THIS IS NOT THE CEREMONY. It is a single-contributor, throwaway-entropy  │
# │  dry-run that proves the snarkjs/circom pipeline works end-to-end against │
# │  the FROZEN circuit, then DELETES every key it produced. A key made here  │
# │  is cryptographically UNSAFE (one known entropy source, a test beacon) —  │
# │  it must never reach mainnet. The real ceremony needs N independent       │
# │  contributors (see ceremony-setup.sh + the runbook).                      │
# └─────────────────────────────────────────────────────────────────────────┘
#
# What it confirms (the §3.4 gap that `wtns calculate` alone can't):
#   frozen circuit → ptau → genesis zkey → contribution → beacon → final zkey
#   → real witness from the committed fixture → groth16 PROVE → groth16 VERIFY ✓
#   → public-signal ordering matches UTXOPool.sol's uint256[8] layout.
# If this is green, the post-ceremony "drop in artifacts → deploy" path has no
# toolchain surprises; only the multi-contributor ceremony + audit remain.
#
# Usage:  bash scripts/ceremony-dryrun-smoke.sh
# Exit:   0 = pipeline OK (and all throwaway keys deleted); non-zero = a real
#         problem in the circuit/toolchain that must be fixed BEFORE a ceremony.
#
# Reuses already-present artifacts when available (the 2026-06-13 dry-run left a
# compiled r1cs/wasm + a genesis zkey + the ptau under build/ceremony*). Falls
# back to recompiling via ceremony-setup.sh init if they are missing.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CIRCUIT="circuits/note_spend.circom"
FROZEN_SHA256="1211d4971de6e1b157e78565275ed8f0d8e7f68304b8b1b69696014b4a352266"
PTAU_FILE="powersOfTau28_hez_final_18.ptau"
FIXTURE="test/fixtures/note_spend_input.json"
SNARKJS="npx snarkjs"
# Throwaway test beacon — identical to ceremony-setup.sh's; only ever valid in a
# dry-run. A real finalize uses a pre-announced public block hash.
TEST_BEACON="0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"

say()  { printf "\033[1;36m[dryrun]\033[0m %s\n" "$*"; }
ok()   { printf "\033[1;32m[dryrun] PASS:\033[0m %s\n" "$*"; }
die()  { printf "\033[1;31m[dryrun] FAIL:\033[0m %s\n" "$*" >&2; exit 1; }

# ── Locate the frozen, compiled circuit artifacts (r1cs + wasm) + ptau ────────
# Prefer build/ceremony (the canonical dry-run output dir); fall back to the
# staging repo copy, then recompile.
R1CS=""; WASM=""; PTAU=""; GENESIS=""
for d in build/ceremony build/ceremony-repo-staging/circuit; do
  [ -z "$R1CS" ] && [ -f "$d/note_spend.r1cs" ] && R1CS="$d/note_spend.r1cs"
done
for w in build/ceremony/note_spend_js/note_spend.wasm \
         build/ceremony-repo-staging/circuit/note_spend_js/note_spend.wasm; do
  [ -z "$WASM" ] && [ -f "$w" ] && WASM="$w"
done
for p in build/ceremony/$PTAU_FILE build/ceremony-repo-staging/$PTAU_FILE; do
  [ -z "$PTAU" ] && [ -f "$p" ] && PTAU="$p"
done
for g in build/ceremony/note_spend_0000.zkey \
         build/ceremony-repo-staging/releases/genesis/note_spend_0000.zkey; do
  [ -z "$GENESIS" ] && [ -f "$g" ] && GENESIS="$g"
done

# ── Freeze check: the smoke MUST run against the frozen circuit source ─────────
got=$(shasum -a 256 "$CIRCUIT" | awk '{print $1}')
[ "$got" = "$FROZEN_SHA256" ] \
  || die "circuit drift — $CIRCUIT no longer matches the frozen hash.
  expected $FROZEN_SHA256
  got      $got
  Re-freeze (CIRCUIT_FROZEN_FOR_AUDIT.md) before any ceremony work."
ok "circuit matches frozen hash"

# If r1cs/wasm/genesis/ptau are missing, recompile + re-init via the canonical
# script (writes into build/ceremony). This keeps a single source of truth for
# the compile flags + ptau verification.
if [ -z "$R1CS" ] || [ -z "$WASM" ] || [ -z "$PTAU" ] || [ -z "$GENESIS" ]; then
  say "compiled artifacts incomplete (r1cs=$R1CS wasm=$WASM ptau=$PTAU genesis=$GENESIS)"
  say "running ceremony-setup.sh init to (re)compile + init the genesis zkey…"
  CEREMONY_DRYRUN=1 bash scripts/ceremony-setup.sh init
  R1CS="build/ceremony/note_spend.r1cs"
  WASM="build/ceremony/note_spend_js/note_spend.wasm"
  PTAU="build/ceremony/$PTAU_FILE"
  GENESIS="build/ceremony/note_spend_0000.zkey"
fi
[ -f "$FIXTURE" ] || die "witness fixture missing: $FIXTURE (run scripts/build-note-spend-witness.ts)"
say "r1cs:    $R1CS"
say "wasm:    $WASM"
say "ptau:    $PTAU"
say "genesis: $GENESIS"
say "fixture: $FIXTURE"

# ── Throwaway workspace — auto-deleted on ANY exit (incl. failure) ────────────
# The trap is the safety guarantee: no unsafe zkey can survive this script, even
# if a step fails midway. (Runbook line 229: delete the dry-run key.)
TMP="$(mktemp -d)"
cleanup() { rm -rf "$TMP"; printf "\033[1;36m[dryrun]\033[0m throwaway keys deleted (%s)\n" "$TMP"; }
trap cleanup EXIT
say "throwaway workspace: $TMP"

# ── 1. One throwaway contribution onto the genesis zkey ───────────────────────
say "contributing one THROWAWAY entropy onto the genesis zkey…"
$SNARKJS zkey contribute "$GENESIS" "$TMP/c1.zkey" \
  --name="dryrun-throwaway (DELETE)" -e="$(openssl rand -hex 64)" >/dev/null 2>&1 \
  || die "zkey contribute failed"
ok "contribution applied"

# ── 2. Throwaway beacon → final zkey ──────────────────────────────────────────
say "applying the THROWAWAY test beacon → final zkey…"
$SNARKJS zkey beacon "$TMP/c1.zkey" "$TMP/final.zkey" "$TEST_BEACON" 10 \
  -n="dryrun beacon (DELETE)" >/dev/null 2>&1 || die "zkey beacon failed"
ok "final (throwaway) zkey produced"

# ── 3. Verify the full transcript (r1cs + ptau + final zkey) ──────────────────
say "verifying the full transcript…"
$SNARKJS zkey verify "$R1CS" "$PTAU" "$TMP/final.zkey" >/dev/null 2>&1 \
  || die "zkey verify failed — the contribution chain is corrupt"
ok "transcript verifies (ZKey Ok)"

# ── 4. Calculate a real witness from the committed fixture ────────────────────
say "calculating witness from the committed fixture…"
$SNARKJS wtns calculate "$WASM" "$FIXTURE" "$TMP/witness.wtns" >/dev/null 2>&1 \
  || die "wtns calculate failed — the fixture does NOT satisfy the circuit"
ok "witness satisfies the circuit"

# ── 5. Prove + verify off-chain (the §3.4 step wtns-calculate can't do alone) ──
say "generating a Groth16 proof + verifying it off-chain…"
$SNARKJS groth16 prove "$TMP/final.zkey" "$TMP/witness.wtns" \
  "$TMP/proof.json" "$TMP/public.json" >/dev/null 2>&1 || die "groth16 prove failed"
$SNARKJS zkey export verificationkey "$TMP/final.zkey" "$TMP/vkey.json" >/dev/null 2>&1 \
  || die "vkey export failed"
$SNARKJS groth16 verify "$TMP/vkey.json" "$TMP/public.json" "$TMP/proof.json" >/dev/null 2>&1 \
  || die "groth16 verify FAILED — a proof from this setup does not verify"
ok "Groth16 proof VERIFIES off-chain"

# ── 6. Public-signal ordering matches UTXOPool.sol's uint256[8] layout ────────
# Expected v1 layout: [0..1] nullifierHashes, [2..3] outputCommitments,
# [4] stateRoot, [5] stateTreeDepth, [6] aspRoot, [7] context.
NSIG=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$TMP/public.json','utf8')).length)")
[ "$NSIG" = "8" ] || die "expected 8 public signals (uint256[8]); got $NSIG"
ok "public-signal count is 8 (matches the contract layout)"
say "public signals:"
node -e '
  const s = JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
  const names=["nullHash0","nullHash1","outCom0","outCom1","stateRoot","stateTreeDepth","aspRoot","context"];
  s.forEach((v,i)=>console.log("    ["+i+"] "+names[i]+" = "+v));
' "$TMP/public.json"

printf "\n\033[1;32m========================================================================\033[0m\n"
printf "\033[1;32m DRY-RUN SMOKE PASSED\033[0m — toolchain works end-to-end against the frozen circuit:\n"
printf "   frozen circuit → ptau → genesis → contribution → beacon → final zkey\n"
printf "   → real witness → PROVE → VERIFY ✓ → 8 signals match uint256[8].\n"
printf "\033[1;33m This is NOT a production setup.\033[0m The keys it made are deleted (one known\n"
printf " entropy + a test beacon = unsafe). The real ceremony adds N independent\n"
printf " contributors (scripts/ceremony-setup.sh + the runbook) and an audit.\n"
printf "\033[1;32m========================================================================\033[0m\n"
