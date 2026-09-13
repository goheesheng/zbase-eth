/**
 * ASP deposit fetch + screening — shared between POST /api/asp-update (which
 * builds & posts the approved-label Merkle root) and GET /api/asp-update/rejected
 * (which reports what was excluded and why).
 *
 * Screening = "which deposits may join the ASP approved set." A deposit whose
 * depositor is flagged by the OFAC/risk provider has its LABEL excluded from the
 * tree, so it can never satisfy the withdrawal association proof (can't privately
 * withdraw). See src/lib/ofac-screening.ts for the L1+L2 provider.
 *
 * The event-fetch logic (HyperSync single-query, else chunked public-RPC scan)
 * is lifted from the original asp-update route so behavior is unchanged on Base
 * — screening just filters the result. The chunk size is dynamic (see
 * fetchDepositedEvents below) so a chain without a HyperSync entitlement (e.g.
 * Ethereum) can use its own measured eth_getLogs range cap.
 */

import { createPublicClient, http } from "viem";
import { getActiveChain, getActiveStack } from "./contracts";
import { hexBlock } from "./indexer";
import { hypersyncUrlFor, hypersyncToken } from "./hypersync";

/**
 * Structural subset of a viem public client — just the two reads we need. viem's
 * `getLogs` is too heavily generic to express precisely here, and a chain-
 * specialized client (from `createPublicClient({ chain })`) won't satisfy the
 * exported `PublicClient` type by structural assignment. We adapt at the boundary
 * with `any`-typed methods (an external-lib seam, not app logic) and re-impose
 * exact types on the *result* via the `RawLog` cast below.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
type LogReader = {
  getLogs: (args: any) => Promise<any[]>;
  getBlockNumber: () => Promise<bigint>;
};
/* eslint-enable @typescript-eslint/no-explicit-any */
import {
  type ReasonCode,
  type SanctionsProvider,
  createConfiguredScreeningProvider,
  type ScreeningSource,
} from "./ofac-screening";

export const DEPOSITED_EVENT = {
  type: "event" as const,
  name: "Deposited" as const,
  inputs: [
    { name: "_depositor", type: "address" as const, indexed: true as const },
    { name: "_commitment", type: "uint256" as const, indexed: false as const },
    { name: "_label", type: "uint256" as const, indexed: false as const },
    { name: "_value", type: "uint256" as const, indexed: false as const },
    { name: "_precommitmentHash", type: "uint256" as const, indexed: false as const },
  ],
};

export interface DepositedLog {
  depositor: `0x${string}`;
  label: bigint;
  txHash: `0x${string}`;
  blockNumber: bigint;
}

export interface RejectedDeposit {
  depositor: `0x${string}`;
  /** Decimal string (labels are uint256). */
  label: string;
  txHash: `0x${string}`;
  blockNumber: string;
  reasonCode: ReasonCode;
}

export interface ScreenResult {
  /** Labels that passed screening, in event order — feed straight into the tree. */
  approvedLabels: bigint[];
  rejected: RejectedDeposit[];
  screened: number;
  snapshotVersion: string;
  source: ScreeningSource;
}

/**
 * Fetch all `Deposited` events for a pool since deployment. HyperSync when
 * this chain is entitled (no block-range limit), else chunked queries on the
 * given public client.
 */
export async function fetchDepositedEvents(args: {
  publicClient: LogReader;
  poolAddress: `0x${string}`;
  poolDeployBlock: bigint;
}): Promise<DepositedLog[]> {
  const { publicClient, poolAddress, poolDeployBlock } = args;

  // B6 residual fix (2026-07-04): derive the HyperSync chain + endpoint from the
  // ACTIVE network instead of hardcoding Base Sepolia. On a mainnet flip with
  // HYPERSYNC_TOKEN set, the old code queried the Sepolia HyperSync endpoint for
  // mainnet pool logs → empty/wrong ASP. Now network-correct on both chains.
  //
  // `hs` is null when this chain isn't HyperSync-entitled (our token is
  // Base-only today — see src/lib/hypersync.ts), in which case we fall back to
  // a chunked scan on the given public client instead of a single unbounded call.
  const activeChain = getActiveChain();
  const hs = hypersyncUrlFor(activeChain.chain.id);
  const hyperClient: LogReader = hs
    ? createPublicClient({
        chain: activeChain.chain,
        transport: http(hs, {
          fetchOptions: { headers: { Authorization: `Bearer ${hypersyncToken()}` } },
        }),
      })
    : publicClient;

  type RawLog = {
    args: { _depositor?: `0x${string}`; _label?: bigint };
    transactionHash: `0x${string}`;
    blockNumber: bigint;
  };

  let logs: RawLog[];
  if (hs) {
    logs = (await hyperClient.getLogs({
      address: poolAddress,
      // Pre-hex for HyperSync (rejects decimal blocks; prod bundle emitted decimal).
      fromBlock: hexBlock(poolDeployBlock) as unknown as bigint,
      event: DEPOSITED_EVENT,
      toBlock: "latest",
    })) as unknown as RawLog[];
  } else {
    // RPC-fallback chunk size: LOG_CHUNK_BLOCKS env override, else the active
    // stack's per-chain cap (agent S1: 10_000 for Base stacks, 50_000 for
    // eth-sepolia — measured eth_getLogs range caps), else 10_000 as a safe
    // default. Was a hardcoded 1999-block cap before this change.
    const chunkBlocks = BigInt(
      Number(process.env.LOG_CHUNK_BLOCKS ?? getActiveStack().logChunkBlocks ?? 10_000),
    );
    const currentBlock = await publicClient.getBlockNumber();
    const all: RawLog[] = [];
    for (let from = poolDeployBlock; from <= currentBlock; from += chunkBlocks) {
      const to =
        from + chunkBlocks - 1n > currentBlock ? currentBlock : from + chunkBlocks - 1n;
      const chunkLogs = (await publicClient.getLogs({
        address: poolAddress,
        event: DEPOSITED_EVENT,
        fromBlock: from,
        toBlock: to,
      })) as unknown as RawLog[];
      all.push(...chunkLogs);
    }
    logs = all;
  }

  return logs
    .filter((l) => l.args._depositor !== undefined && l.args._label !== undefined)
    .map((l) => ({
      depositor: l.args._depositor as `0x${string}`,
      label: l.args._label as bigint,
      txHash: l.transactionHash,
      blockNumber: l.blockNumber,
    }));
}

/**
 * Screen a set of deposits: partition into approved labels (in input order) and
 * rejected entries with reason codes. Loads the OFAC snapshot + overlay once.
 * Pass a provider to reuse one across calls (e.g. tests); otherwise one is built
 * from the current snapshot.
 */
export async function screenDeposits(
  deposits: readonly DepositedLog[],
  provider?: SanctionsProvider,
  snapshotMeta?: { version: string; source: ScreeningSource },
): Promise<ScreenResult> {
  let prov = provider;
  let version = snapshotMeta?.version;
  let source = snapshotMeta?.source;

  if (!prov) {
    const configured = await createConfiguredScreeningProvider();
    prov = configured.provider;
    version = prov.snapshotVersion;
    source = configured.source;
  }

  const approvedLabels: bigint[] = [];
  const rejected: RejectedDeposit[] = [];

  for (const d of deposits) {
    const reason = prov.screenAddress
      ? await prov.screenAddress(d.depositor)
      : prov.reasonFor(d.depositor);
    if (reason) {
      rejected.push({
        depositor: d.depositor,
        label: d.label.toString(),
        txHash: d.txHash,
        blockNumber: d.blockNumber.toString(),
        reasonCode: reason,
      });
    } else {
      approvedLabels.push(d.label);
    }
  }

  return {
    approvedLabels,
    rejected,
    screened: deposits.length,
    snapshotVersion: version ?? prov.snapshotVersion,
    source: source ?? "fallback",
  };
}
