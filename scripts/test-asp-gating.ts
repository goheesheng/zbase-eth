/**
 * ASP gating test — proves `screenDeposits` EXCLUDES a flagged depositor's label
 * from the approved set that feeds the Merkle tree, and keeps clean labels.
 *
 * The provider-layer reason codes are covered by scripts/test-ofac-screening.ts.
 * This closes the loop: it exercises the exact partition (src/lib/asp-screening.ts
 * `screenDeposits`) that src/lib/asp-root-updater.ts builds the ASP root from, so a
 * flagged deposit can never satisfy the withdrawal association proof.
 *
 *   npx tsx scripts/test-asp-gating.ts
 */

import * as assert from "node:assert/strict";
import { screenDeposits, type DepositedLog } from "../src/lib/asp-screening";
import { staticFallbackProvider } from "../src/lib/ofac-screening";

// One real OFAC-SDN address (L1), one Tornado pool kept as policy (L2), two clean.
const L1_OFAC = "0x0330070fd38ec3bb94f58fa55d40368271e9e54a" as const;
const L2_TORNADO = "0x722122df12d4e14e13ac3b6895a86e84145b6967" as const;
const CLEAN_A = "0x1111111111111111111111111111111111111111" as const;
const CLEAN_B = "0x2222222222222222222222222222222222222222" as const;

function dep(depositor: `0x${string}`, label: bigint): DepositedLog {
  return {
    depositor,
    label,
    txHash: `0x${label.toString(16).padStart(64, "0")}` as `0x${string}`,
    blockNumber: label,
  };
}

async function main(): Promise<void> {
  // Deterministic offline provider (vendored OFAC L1 + curated L2 overlay) — the
  // same address sets the live single-operator route screens against.
  const provider = staticFallbackProvider();

  const deposits: DepositedLog[] = [
    dep(CLEAN_A, 100n),
    dep(L1_OFAC, 200n), // must be excluded — OFAC SDN
    dep(CLEAN_B, 300n),
    dep(L2_TORNADO, 400n), // must be excluded — policy-mixer
  ];

  const result = await screenDeposits(deposits, provider);

  // 1. Only the two clean labels survive into the tree-input, IN ORDER.
  assert.deepEqual(
    result.approvedLabels,
    [100n, 300n],
    "approvedLabels must contain only clean deposits, in event order",
  );

  // 2. Both flagged deposits are rejected with the right reason codes.
  assert.equal(result.rejected.length, 2, "both flagged deposits rejected");
  const byLabel = new Map(result.rejected.map((r) => [r.label, r.reasonCode]));
  assert.equal(byLabel.get("200"), "ofac-sdn-direct", "OFAC deposit → ofac-sdn-direct");
  assert.equal(byLabel.get("400"), "policy-mixer", "Tornado deposit → policy-mixer");

  // 3. The flagged labels are NOT in the approved set (can't ever be withdrawn).
  assert.ok(!result.approvedLabels.includes(200n), "OFAC label excluded from tree input");
  assert.ok(!result.approvedLabels.includes(400n), "Tornado label excluded from tree input");

  // 4. Counters are consistent.
  assert.equal(result.screened, 4, "screened counts every deposit");
  assert.equal(
    result.approvedLabels.length + result.rejected.length,
    result.screened,
    "approved + rejected == screened (no deposit silently dropped)",
  );

  console.log(
    `screenDeposits gate ok — screened=${result.screened} approved=[${result.approvedLabels.join(
      ", ",
    )}] rejected=${result.rejected
      .map((r) => `${r.label}:${r.reasonCode}`)
      .join(", ")}`,
  );
  console.log("scripts/test-asp-gating.ts: flagged deposits are excluded from the ASP set");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
