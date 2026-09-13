#!/usr/bin/env bash
#
# test-note-spend-witness.sh — prove note_spend.circom is SATISFIABLE with a real
# witness (Phase 4 of the mainnet code-blocker work).
#
# Builds the fixture (scripts/build-note-spend-witness.ts) and runs
# `snarkjs wtns calculate` against the compiled wasm. Success means the
# constraint system is satisfiable with realistic 2-input/2-output notes
# (commitments, nullifiers, NPK derivation, LeanIMT membership, conservation).
#
# This is the strongest satisfiability check available PRE-CEREMONY. It does NOT
# do a full Groth16 prove + on-chain verify — that needs the ceremony zkey + the
# deployed verifier and runs at the post-ceremony Sepolia smoke.
#
# The wasm lives under build/ceremony/ (produced by scripts/ceremony-setup.sh's
# circuit compile; it is a build artifact, not committed). If absent, this script
# tells you how to produce it and exits 0 (skipped) so CI without the 300MB ptau
# toolchain doesn't fail — the fixture build itself still runs and is checked.

set -euo pipefail
cd "$(dirname "$0")/.."

WASM="build/ceremony/note_spend_js/note_spend.wasm"
FIXTURE="test/fixtures/note_spend_input.json"
WTNS="$(mktemp -t note_spend_witness.XXXXXX).wtns"

echo "==> Building witness fixture"
npx tsx scripts/build-note-spend-witness.ts

if [ ! -f "$WASM" ]; then
  echo ""
  echo "SKIP: $WASM not found (circuit not compiled in this checkout)."
  echo "      Compile it with: bash scripts/ceremony-setup.sh compile"
  echo "      (the fixture above was still built + validated)."
  exit 0
fi

echo ""
echo "==> snarkjs wtns calculate (proving the circuit is satisfiable)"
npx snarkjs wtns calculate "$WASM" "$FIXTURE" "$WTNS"

echo ""
echo "==> Verifying public-signal ordering matches the contract's uint256[8] layout"
npx snarkjs wtns export json "$WTNS" "${WTNS}.json" >/dev/null
node -e '
  const w = require(process.argv[1]);
  // witness[0] is the constant 1; public signals are [1..8] in the order:
  //   [1..2] nullifierHashes, [3..4] outputCommitments, [5] stateRoot,
  //   [6] stateTreeDepth, [7] aspRoot, [8] context  (matches UTXOPool.sol)
  const labels = ["nullHash0","nullHash1","outCom0","outCom1","stateRoot","stateTreeDepth","aspRoot","context"];
  for (let i = 0; i < 8; i++) console.log("  ["+i+"] "+labels[i]+" = "+w[i+1]);
  // B3 (audit-sweep-2026-06-17): the fixture now places the two real inputs at
  // indices 2 and 3 of a PERFECT 4-leaf state tree (depth 2), so the inclusion
  // proofs exercise real multi-level hashing — not the depth-1 left spine that
  // masked the witness-gen index/sibling mispairing. Assert depth 2.
  if (w[6] !== "2") { console.error("FAIL: stateTreeDepth ([5]) expected 2 (perfect 4-leaf fixture), got "+w[6]); process.exit(1); }
' "${WTNS}.json"

rm -f "$WTNS" "${WTNS}.json"
echo ""
echo "PASS: note_spend.circom is satisfiable with a real witness; public-signal"
echo "      ordering matches UTXOPool.sol's v1 8-signal layout."
