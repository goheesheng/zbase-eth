#!/usr/bin/env bash
# Adversarial-audit regression suite — runs every fund-safety test guarding the
# executor + forwarding rail in one shot. See docs/security/adversarial-audit-harness.md.
#
#   ⚠️ Passing this is INTERNAL review only — it does NOT satisfy the external C1
#   audit required before mainnet real money.
#
# Usage: bash scripts/audit-regression.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "=== zBase fund-safety regression suite ==="
echo

echo "[1/5] Executor contract tests (forge)…"
forge test --match-contract ExecutorProcessooor -vv | tail -3

echo
echo "[2/5] D3 forwarding-note fund-safety tests…"
npx tsx packages/core/src/forwardingNotes.test.ts | tail -2

echo
echo "[3/5] Forwarding watcher compliance-gate tests…"
npx tsx scripts/test-forwarding-watcher.ts | tail -2

echo
echo "[4/5] Forwarding registry authz tests…"
npx tsx scripts/test-forwarding-authz.ts | tail -2

echo
echo "[5/6] Forwarding engine fund-safety tests…"
npx tsx scripts/test-forwarding-engine.ts | tail -2

echo
echo "[6/7] Forwarding authority (deposit-call + provisioning guard)…"
npx tsx scripts/test-forwarding-authority.ts | tail -2

echo
echo "[7/8] Fee-tier resolution (downgrade prevention, audit #3)…"
npx tsx scripts/test-fee-tier-resolution.ts | tail -2

echo
echo "[8/10] Forwarding persistence (corrupt-halt + atomic write, regression HIGH)…"
npx tsx scripts/test-forwarding-persistence.ts | tail -2

echo
echo "[9/10] Postman receipt.status (reverted-tx guard, HIGH-2)…"
npx tsx scripts/test-receipt-status.ts | tail -2

echo
echo "[10/12] Consumed-tx namespace (cross-purpose collision, #5)…"
npx tsx scripts/test-consumed-tx-namespace.ts | tail -2

echo
echo "[11/12] SDK facilitator baseUrl guard (C3 secret-exfil)…"
( cd packages/core && npx tsx src/facilitatorClient.test.ts ) | tail -2

echo
echo "[12/12] SDK HIGH fixes (deserialize range + viewingKey seed)…"
( cd packages/core && npx tsx src/high-fixes.test.ts ) | tail -2

echo
echo "=== all fund-safety regression suites passed ==="
echo "NOTE: internal review only — external C1 audit still required before mainnet."
