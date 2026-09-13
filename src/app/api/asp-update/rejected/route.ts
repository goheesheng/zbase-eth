import { NextResponse } from "next/server";
import { createPublicClient, http } from "viem";
import { getActiveStack, getActiveChain } from "@/lib/contracts";
import { createConfiguredScreeningProvider } from "@/lib/ofac-screening";
import { fetchDepositedEvents, screenDeposits } from "@/lib/asp-screening";

const _stack = getActiveStack();
const USDC_POOL_ADDRESS = _stack.usdcPool;
const POOL_DEPLOY_BLOCK = _stack.poolDeployBlock;

/**
 * GET /api/asp-update/rejected
 *
 * Read-only, idempotent status surface: which deposits were EXCLUDED from the ASP
 * approved set, and why. Drives a future "your deposit was rejected — ragequit to
 * reclaim" prompt. It re-runs the same (cheap, cached) OFAC+overlay screen the
 * POST handler uses, but NEVER touches the chain — no updateRoot, no writes.
 *
 * Returns:
 *   {
 *     rejected: [{ depositor, label, txHash, blockNumber, reasonCode }],
 *     approvedCount, screened, snapshotVersion, snapshotSource
 *   }
 *
 * `reasonCode` ∈ ofac-sdn-direct | policy-mixer | policy-hack | operator-pin
 * | chainalysis-risk.
 * The depositor + label are already public in the on-chain `Deposited` event, so
 * surfacing them here adds no disclosure beyond what the chain already shows.
 */
export async function GET() {
  try {
    const activeChain = getActiveChain();
    const rpcUrl = activeChain.readRpcUrl;
    const rpcConfigured =
      activeChain.network === "mainnet"
        ? Boolean(process.env.BASE_MAINNET_RPC || process.env.NEXT_PUBLIC_BASE_MAINNET_RPC)
        : activeChain.network === "eth-sepolia"
          ? Boolean(process.env.ETH_SEPOLIA_RPC || process.env.NEXT_PUBLIC_ETH_SEPOLIA_RPC)
          : Boolean(process.env.BASE_SEPOLIA_RPC || process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC);
    if (!rpcConfigured) {
      const missing =
        activeChain.network === "mainnet"
          ? "BASE_MAINNET_RPC"
          : activeChain.network === "eth-sepolia"
            ? "ETH_SEPOLIA_RPC"
            : "BASE_SEPOLIA_RPC";
      return NextResponse.json({ error: `Missing ${missing}` }, { status: 500 });
    }

    const publicClient = createPublicClient({
      chain: activeChain.chain,
      transport: http(rpcUrl),
    });

    const deposits = await fetchDepositedEvents({
      publicClient,
      poolAddress: USDC_POOL_ADDRESS as `0x${string}`,
      poolDeployBlock: POOL_DEPLOY_BLOCK,
    });

    const configuredScreening = await createConfiguredScreeningProvider();
    const provider = configuredScreening.provider;
    const screen = await screenDeposits(deposits, provider, {
      version: provider.snapshotVersion,
      source: configuredScreening.source,
    });

    return NextResponse.json({
      rejected: screen.rejected,
      approvedCount: screen.approvedLabels.length,
      screened: screen.screened,
      snapshotVersion: screen.snapshotVersion,
      snapshotSource: screen.source,
    });
  } catch (error) {
    console.error("[ASP Rejected] Error:", error);
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
