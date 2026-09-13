import {
  isZeroAddress,
  type ContractStack,
} from "@/lib/contracts";

export type ExecutorGate =
  | { enabled: true; executor: `0x${string}` }
  | {
      enabled: false;
      code: "mainnet_audit_approval_required" | "executor_not_configured";
      error: string;
    };

/**
 * One launch gate for every hosted executor entrypoint.
 *
 * The on-chain executor is immutable and permissionless once deployed, so the
 * mainnet environment flag is an explicit post-audit approval, not a default.
 * Both /facilitator/call and the lower-level /withdraw callPlan branch must use
 * this helper; otherwise configuring only an address bypasses the public gate.
 */
export function executorGateForStack(
  stack: ContractStack,
  mainnetApproved = process.env.ZBASE_ENABLE_MAINNET_EXECUTOR === "true",
): ExecutorGate {
  if (stack.facilitatorNetwork === "eip155:8453" && !mainnetApproved) {
    return {
      enabled: false,
      code: "mainnet_audit_approval_required",
      error:
        "ExecutorProcessooor is disabled on Base mainnet until the executor path has an external audit and an explicit ZBASE_ENABLE_MAINNET_EXECUTOR=true launch approval.",
    };
  }

  const executor = stack.executorProcessooor;
  if (isZeroAddress(executor)) {
    return {
      enabled: false,
      code: "executor_not_configured",
      error:
        "ExecutorProcessooor not deployed on the active stack. Set EXECUTOR_PROCESSOOOR only after the audited deployment is verified.",
    };
  }

  return { enabled: true, executor: executor as `0x${string}` };
}
