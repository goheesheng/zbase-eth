#!/usr/bin/env bash
# deploy-utxo-pool.sh — one-shot deploy of UTXOPool on Base Sepolia.
#
# 2026-06-09. Phase 1A scaffold (Shipment A.1). Deploys the UTXOPool
# contract at zbase-protocol/pkg/contracts/src/contracts/UTXOPool.sol with
# constructor args (_verifier, _entrypoint, _token, _scope).
#
# Coexists with the existing single-value PrivacyPoolMorpho deployment at
# 0x4ebcfeaf661a25f103b3d1f16be5a7668ab0935a — the two pools share the
# Entrypoint and USDC token but have DISJOINT anonymity sets by design
# (different SCOPE values). Users opt into UTXO via `?pool=utxo` on the
# withdraw + facilitator endpoints.
#
# Required env vars (refused if missing):
#   DEPLOYER_PRIVATE_KEY    — hex (with or without 0x). Used to sign the deploy.
#
# Optional env vars (sensible defaults provided):
#   BASE_SEPOLIA_RPC        — defaults to https://sepolia.base.org
#   USDC_ADDRESS            — defaults to 0x036CbD53842c5426634e7929541eC2318f3dCF7e
#                             (Circle USDC on Base Sepolia, matches CLAUDE.md)
#   ENTRYPOINT_ADDRESS      — defaults to 0x598ffaac79ae29b1aae571fd91899d4492183688
#                             (deployed Entrypoint, matches CLAUDE.md)
#   VERIFIER_ADDRESS        — defaults to 0x0000000000000000000000000000000000000000
#                             which the script REFUSES to deploy with (forces the
#                             operator to make an explicit choice between
#                             UnsafeMockVerifier and the real ceremony output).
#   SCOPE_HEX               — defaults to keccak256("zbase-utxo-pool-v0" || USDC).
#                             Override only if you're deploying a second UTXO
#                             pool with a deliberately distinct anonymity set.
#
# Usage:
#   DEPLOYER_PRIVATE_KEY=0xabc... bash scripts/deploy-utxo-pool.sh
#
# Idempotency: this script does NOT check on-chain whether a UTXOPool is
# already deployed (Foundry deploys are not naturally idempotent). It DOES
# read src/lib/contracts.ts and warn loudly if UTXO_STACK.usdcPool is
# already a non-zero address; the operator can re-deploy by passing
# `--force` to bypass the warning.
#
# After deploy: paste the printed address into src/lib/contracts.ts
# UTXO_STACK.usdcPool and bump `poolDeployBlock` to the deploy block.

set -euo pipefail

# ─── Repo root ─────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." &> /dev/null && pwd)"
CONTRACTS_FILE="${REPO_ROOT}/src/lib/contracts.ts"

# ─── Arg parsing ───────────────────────────────────────────────────────────────
FORCE=0
for arg in "$@"; do
  case "${arg}" in
    --force) FORCE=1 ;;
    -h|--help)
      grep '^# ' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown arg: ${arg} (try --help)" >&2
      exit 64
      ;;
  esac
done

# ─── Idempotency check ─────────────────────────────────────────────────────────
if [[ -f "${CONTRACTS_FILE}" ]]; then
  CURRENT_UTXO=$(grep -E 'usdcPool: "0x[0-9a-fA-F]+' "${CONTRACTS_FILE}" \
    | grep -v '^[[:space:]]*//' \
    | sed -n '2p' \
    | sed -E 's/.*usdcPool: "(0x[0-9a-fA-F]+).*/\1/' \
    || echo "")
  if [[ -n "${CURRENT_UTXO}" && "${CURRENT_UTXO}" != "0x0000000000000000000000000000000000000000" ]]; then
    echo "⚠️  WARNING: UTXO_STACK.usdcPool in src/lib/contracts.ts is already set:"
    echo "    ${CURRENT_UTXO}"
    if [[ "${FORCE}" -ne 1 ]]; then
      echo "    Refusing to deploy a second UTXO pool. Pass --force to override."
      echo "    (Re-deploying creates a new anonymity set; existing UTXO deposits"
      echo "     remain spendable only against the OLD pool address.)"
      exit 1
    fi
    echo "    --force passed; proceeding anyway."
  fi
fi

# ─── Env var validation ────────────────────────────────────────────────────────
: "${DEPLOYER_PRIVATE_KEY:?DEPLOYER_PRIVATE_KEY is required (deployer key)}"

BASE_SEPOLIA_RPC="${BASE_SEPOLIA_RPC:-https://sepolia.base.org}"
USDC_ADDRESS="${USDC_ADDRESS:-0x036CbD53842c5426634e7929541eC2318f3dCF7e}"
ENTRYPOINT_ADDRESS="${ENTRYPOINT_ADDRESS:-0x598ffaac79ae29b1aae571fd91899d4492183688}"
VERIFIER_ADDRESS="${VERIFIER_ADDRESS:-0x0000000000000000000000000000000000000000}"

if [[ "${VERIFIER_ADDRESS}" == "0x0000000000000000000000000000000000000000" ]]; then
  cat >&2 <<'EOF'
❌ VERIFIER_ADDRESS is not set.

The UTXOPool constructor requires a verifier contract address. You have two choices:

  1. Test deploy:  point at an `UnsafeMockVerifier` (accepts any proof) and use
                   `/api/withdraw?pool=utxo&unsafeTestMode=true` to exercise the
                   wire format. Agent B's test scaffold deploys one in-test;
                   for a Base Sepolia deploy, deploy your own via forge create
                   first and export its address as VERIFIER_ADDRESS.

  2. Production:   point at the `Verifier_NoteSpend` produced by the trusted-
                   setup ceremony for circuits/note_spend.circom. Blocked until
                   the ceremony completes (Phase 3).

Then re-run:
  VERIFIER_ADDRESS=0x...  DEPLOYER_PRIVATE_KEY=0x...  bash scripts/deploy-utxo-pool.sh
EOF
  exit 1
fi

# Compute SCOPE deterministically if not overridden — must differ from the
# single-value pool's SCOPE so anonymity sets stay disjoint.
if [[ -z "${SCOPE_HEX:-}" ]]; then
  # cast keccak256("zbase-utxo-pool-v0|<usdc>")
  if ! command -v cast >/dev/null 2>&1; then
    echo "❌ cast (Foundry) is required to compute the default SCOPE. Install Foundry: https://book.getfoundry.sh/getting-started/installation"
    exit 1
  fi
  SCOPE_HEX=$(cast keccak "zbase-utxo-pool-v0|${USDC_ADDRESS}")
fi

# ─── Preflight ─────────────────────────────────────────────────────────────────
NORMALIZED_KEY="${DEPLOYER_PRIVATE_KEY#0x}"
DEPLOYER_ADDRESS=$(cast wallet address "0x${NORMALIZED_KEY}" 2>/dev/null || echo "<failed to derive>")

cat <<EOF
═══════════════════════════════════════════════════════════════════
  Deploy UTXOPool — Phase 1A scaffold
═══════════════════════════════════════════════════════════════════
  Date:               $(date -u +%Y-%m-%dT%H:%M:%SZ)
  Network:            Base Sepolia (84532)
  RPC:                ${BASE_SEPOLIA_RPC}
  Deployer:           ${DEPLOYER_ADDRESS}
  Constructor args:
    _verifier:        ${VERIFIER_ADDRESS}
    _entrypoint:      ${ENTRYPOINT_ADDRESS}
    _token (USDC):    ${USDC_ADDRESS}
    _scope:           ${SCOPE_HEX}
═══════════════════════════════════════════════════════════════════
EOF

# ─── Deploy via forge create ───────────────────────────────────────────────────
cd "${REPO_ROOT}"

# Convert SCOPE_HEX (with 0x) to a decimal uint256 for the constructor.
# forge create accepts hex constructor args natively, but cast --to-dec keeps
# the runbook readable.
SCOPE_DEC=$(cast --to-dec "${SCOPE_HEX}")

# UTXOPool lives under zbase-protocol/pkg/contracts/src/contracts/UTXOPool.sol.
# foundry.toml has a remapping `@zbase-protocol/=zbase-protocol/pkg/contracts/src/`
# so forge can resolve it.
CONTRACT_PATH="zbase-protocol/pkg/contracts/src/contracts/UTXOPool.sol:UTXOPool"

echo "→ Running forge create..."
DEPLOY_OUTPUT=$(
  forge create \
    --rpc-url "${BASE_SEPOLIA_RPC}" \
    --private-key "0x${NORMALIZED_KEY}" \
    --broadcast \
    --constructor-args \
      "${VERIFIER_ADDRESS}" \
      "${ENTRYPOINT_ADDRESS}" \
      "${USDC_ADDRESS}" \
      "${SCOPE_DEC}" \
    "${CONTRACT_PATH}"
)

echo "${DEPLOY_OUTPUT}"

# Extract the deployed address line from forge create output:
#   "Deployed to: 0x...."
DEPLOYED_ADDRESS=$(echo "${DEPLOY_OUTPUT}" | grep -E '^Deployed to:' | awk '{print $3}' || echo "")
DEPLOY_TX=$(echo "${DEPLOY_OUTPUT}" | grep -E '^Transaction hash:' | awk '{print $3}' || echo "")

if [[ -z "${DEPLOYED_ADDRESS}" ]]; then
  echo "❌ Could not parse deployed address from forge output. Check logs above." >&2
  exit 1
fi

# Look up the deploy block from the deploy tx receipt.
DEPLOY_BLOCK=""
if [[ -n "${DEPLOY_TX}" ]]; then
  DEPLOY_BLOCK=$(cast receipt "${DEPLOY_TX}" --rpc-url "${BASE_SEPOLIA_RPC}" --json \
    | sed -nE 's/.*"blockNumber":[[:space:]]*"([^"]+)".*/\1/p' \
    | head -n1 || echo "")
  if [[ -n "${DEPLOY_BLOCK}" && "${DEPLOY_BLOCK}" == 0x* ]]; then
    DEPLOY_BLOCK=$(cast --to-dec "${DEPLOY_BLOCK}")
  fi
fi

cat <<EOF

═══════════════════════════════════════════════════════════════════
  ✅ UTXOPool deployed
═══════════════════════════════════════════════════════════════════
  Address:            ${DEPLOYED_ADDRESS}
  Tx:                 ${DEPLOY_TX:-<unknown>}
  Deploy block:       ${DEPLOY_BLOCK:-<unknown>}
  BaseScan:           https://sepolia.basescan.org/address/${DEPLOYED_ADDRESS}
═══════════════════════════════════════════════════════════════════

NEXT STEPS:

  1. Open src/lib/contracts.ts and update UTXO_STACK:

         usdcPool: "${DEPLOYED_ADDRESS}",
         poolDeployBlock: ${DEPLOY_BLOCK:-0}n,
         withdrawalVerifier: "${VERIFIER_ADDRESS}",

  2. Smoke-test the wire format (unsafeTestMode requires UnsafeMockVerifier):

         npx tsx scripts/test-utxo-spend.ts

  3. For real proof-generation deploy, the trusted-setup ceremony for
     circuits/note_spend.circom must complete first (Phase 3 work).

EOF
