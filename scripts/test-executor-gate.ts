import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  executorGateForStack,
} from "../src/lib/executor-gate.ts";
import type { ContractStack } from "../src/lib/contracts.ts";

const ZERO = "0x0000000000000000000000000000000000000000" as const;
const EXECUTOR = "0x1111111111111111111111111111111111111111" as const;

function stack(
  network: ContractStack["facilitatorNetwork"],
  executorProcessooor: `0x${string}`,
): ContractStack {
  return {
    label: "production",
    stack: "single-value",
    facilitatorNetwork: network,
    entrypoint: EXECUTOR,
    usdcPool: EXECUTOR,
    usdc: EXECUTOR,
    withdrawalVerifier: EXECUTOR,
    commitmentVerifier: EXECUTOR,
    poolDeployBlock: 1n,
    executorProcessooor,
  };
}

assert.deepEqual(executorGateForStack(stack("eip155:8453", EXECUTOR), false), {
  enabled: false,
  code: "mainnet_audit_approval_required",
  error:
    "ExecutorProcessooor is disabled on Base mainnet until the executor path has an external audit and an explicit ZBASE_ENABLE_MAINNET_EXECUTOR=true launch approval.",
});
assert.equal(
  executorGateForStack(stack("eip155:8453", ZERO), true).enabled,
  false,
);
assert.deepEqual(executorGateForStack(stack("eip155:8453", EXECUTOR), true), {
  enabled: true,
  executor: EXECUTOR,
});
assert.deepEqual(executorGateForStack(stack("eip155:84532", EXECUTOR), false), {
  enabled: true,
  executor: EXECUTOR,
});

// Regression for the original bypass: both public surfaces must call the same
// helper. This fails on the old tree where only /facilitator/call checked the
// mainnet flag and /withdraw accepted callPlan directly.
for (const path of [
  "src/app/api/facilitator/call/route.ts",
  "src/app/api/withdraw/route.ts",
]) {
  const source = readFileSync(path, "utf8");
  assert.match(source, /executorGateForStack\(/, `${path} must enforce executor gate`);
}

console.log("EXECUTOR GATE: 6 checks passed");
