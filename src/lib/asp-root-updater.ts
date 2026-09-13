/**
 * Server-side ASP root refresh.
 *
 * This is the only application helper that may submit updateRoot. Public routes
 * must first establish authorization (operator bearer or a confirmed pool
 * deposit) and serialize calls with the Upstash-backed processing lock.
 */

import { createPublicClient, http } from "viem";
import { poseidon2 } from "poseidon-lite";
import { LeanIMT } from "@zk-kit/lean-imt";
import { getActiveStack, getActiveChain } from "@/lib/contracts";
import { createConfiguredScreeningProvider } from "@/lib/ofac-screening";
import { fetchDepositedEvents, screenDeposits } from "@/lib/asp-screening";
import { sendPostmanTx, postmanSignerKind } from "@/lib/postman-signer";

export interface AspRootRefreshResult {
  status: "queued" | "included" | "rejected";
  updated: boolean;
  reason?: string;
  root?: string;
  deposits?: number;
  screened?: number;
  approved?: number;
  rejected?: number;
  snapshotVersion?: string;
  snapshotSource?: string;
  txHash?: `0x${string}`;
}

export async function refreshAspRoot(args: {
  requiredDepositTxHash?: `0x${string}`;
  /** Re-check the distributed lease after scanning, immediately before signing. */
  maySubmitUpdate?: () => Promise<boolean>;
} = {}): Promise<AspRootRefreshResult> {
  const stack = getActiveStack();
  const activeChain = getActiveChain();

  if (postmanSignerKind() === "eoa" && !process.env.POSTMAN_PRIVATE_KEY) {
    throw new Error("Missing POSTMAN_PRIVATE_KEY (POSTMAN_SIGNER=eoa)");
  }

  const publicClient = createPublicClient({
    chain: activeChain.chain,
    transport: http(activeChain.readRpcUrl),
  });
  const deposits = await fetchDepositedEvents({
    publicClient,
    poolAddress: stack.usdcPool,
    poolDeployBlock: stack.poolDeployBlock,
  });

  if (args.requiredDepositTxHash) {
    const required = args.requiredDepositTxHash.toLowerCase();
    if (!deposits.some((deposit) => deposit.txHash.toLowerCase() === required)) {
      return {
        status: "queued",
        updated: false,
        reason: "Confirmed deposit is not visible to the ASP index yet; retry shortly.",
      };
    }
  }

  if (deposits.length === 0) {
    return { status: "queued", updated: false, reason: "No deposits found" };
  }

  const configuredScreening = await createConfiguredScreeningProvider();
  const provider = configuredScreening.provider;
  const screen = await screenDeposits(deposits, provider, {
    version: provider.snapshotVersion,
    source: configuredScreening.source,
  });

  if (screen.rejected.length > 0) {
    console.log(
      `[ASP Update] Screened ${screen.screened} deposits — excluded ${screen.rejected.length} ` +
        `snapshot=${screen.snapshotVersion} source=${screen.source}`,
    );
  }

  const requiredRejected = args.requiredDepositTxHash
    ? screen.rejected.some(
        (deposit) =>
          deposit.txHash.toLowerCase() === args.requiredDepositTxHash!.toLowerCase(),
      )
    : false;
  const requiredStatus = requiredRejected ? "rejected" : "included";

  const tree = new LeanIMT<bigint>((a, b) => poseidon2([a, b]));
  if (screen.approvedLabels.length > 0) tree.insertMany(screen.approvedLabels);
  const newRoot = screen.approvedLabels.length > 0 ? tree.root : 0n;

  let onChainRoot = 0n;
  try {
    onChainRoot = (await publicClient.readContract({
      address: stack.entrypoint,
      abi: [
        {
          name: "latestRoot",
          type: "function",
          stateMutability: "view",
          inputs: [],
          outputs: [{ type: "uint256" }],
        },
      ],
      functionName: "latestRoot",
    })) as bigint;
  } catch {
    onChainRoot = 0n;
  }

  const common = {
    status: requiredStatus,
    root: newRoot.toString(),
    deposits: screen.approvedLabels.length,
    screened: screen.screened,
    approved: screen.approvedLabels.length,
    rejected: screen.rejected.length,
    snapshotVersion: screen.snapshotVersion,
    snapshotSource: screen.source,
  } as const;

  if (newRoot === onChainRoot) {
    return {
      ...common,
      updated: false,
      reason: requiredRejected
        ? "Deposit rejected by association policy; ASP root already current."
        : "ASP root already up to date",
    };
  }

  if (args.maySubmitUpdate && !(await args.maySubmitUpdate())) {
    return {
      ...common,
      status: "queued",
      updated: false,
      reason: "ASP processing lease expired before submission; retry shortly.",
    };
  }

  const ipfsCID = `QmZbaseASPRoot${screen.approvedLabels.length}deposits${Date.now()}pad`;
  const txHash = await sendPostmanTx({
    address: stack.entrypoint,
    abi: [
      {
        name: "updateRoot",
        type: "function",
        stateMutability: "nonpayable",
        inputs: [
          { name: "_root", type: "uint256" },
          { name: "_ipfsCID", type: "string" },
        ],
        outputs: [{ name: "_index", type: "uint256" }],
      },
    ],
    functionName: "updateRoot",
    args: [newRoot, ipfsCID],
    gas: 200_000n,
    chain: activeChain.chain,
    writeRpcUrl: activeChain.writeRpcUrl,
    readRpcUrl: activeChain.readRpcUrl,
  });

  console.log(
    `[ASP Update] Root updated: ${newRoot.toString()} ` +
      `(${screen.approvedLabels.length} approved / ${screen.screened} screened) tx: ${txHash}`,
  );
  return { ...common, updated: true, txHash };
}
