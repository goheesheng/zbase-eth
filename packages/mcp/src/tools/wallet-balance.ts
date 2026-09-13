/**
 * wallet-balance.ts — YOUR balance, rebuilt from the seed.
 *
 * The old `balance` tool returned pool health (anonymity set, ASP root) and argued a
 * per-agent balance "cannot come from the facilitator without breaking privacy, and
 * the agent already knows what it has." The first half is right; the second was the
 * bug. The agent did NOT know what it had — that was the whole reason EPHEMERAL mode
 * existed, and why unspent deposits died at the end of a conversation.
 *
 * Both can be true at once: the facilitator publishes the WHOLE pool's public
 * commitments, and we match them against seed-derived candidates locally. The server
 * learns nothing about which are ours; we learn our balance. No note file, no
 * long-term memory, no secrets in the transcript.
 */
import { z } from "zod";
import { createPublicClient, http, formatUnits, type Chain } from "viem";
import { base, baseSepolia, sepolia } from "viem/chains";
import { getWalletBalance, type WalletBalance } from "@zbase-protocol/core";
import { getOrCreateSeed } from "../wallet.js";
import { ZBASE_FACILITATOR_URL } from "../config.js";

export const walletBalanceSchema = z.object({
  maxIndex: z
    .number()
    .int()
    .min(0)
    .max(500)
    .optional()
    .describe("Highest derivation index to scan (default 50). Raise it only if you have made more than 50 deposits."),
});

/** `mapping(uint256 => bool) public nullifierHashes` — chain truth for "already spent". */
const POOL_SPENT_ABI = [
  {
    name: "nullifierHashes",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "h", type: "uint256" }],
    outputs: [{ type: "bool" }],
  },
] as const;

interface PoolEvents {
  network: string;
  pool: `0x${string}`;
  events: Array<{ commitment: string; label: string; value: string }>;
  withdrawals?: Array<{ value: string; spentNullifier: string; newCommitment: string }>;
}

export async function loadWalletBalance(maxIndex = 50): Promise<WalletBalance & { pool: `0x${string}` }> {
  const res = await fetch(`${ZBASE_FACILITATOR_URL}/api/deposits/events`);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(`Cannot read pool deposits: ${body.error ?? `HTTP ${res.status}`}`);
  }
  const data = (await res.json()) as PoolEvents;

  // ETHONLINE-2026: keyed lookup (not a mainnet-vs-sepolia ternary) so an
  // unrecognized network fails closed instead of silently being treated as
  // Base Sepolia.
  const CHAIN_BY_NETWORK: Record<string, Chain> = {
    "eip155:8453": base,
    "eip155:84532": baseSepolia,
    "eip155:11155111": sepolia,
  };
  const chain = CHAIN_BY_NETWORK[data.network];
  if (!chain) {
    throw new Error(`Unsupported network ${data.network} reported by /api/deposits/events`);
  }
  // isSpent reads nullifierHashes(h) per note. viem's default RPC (mainnet.base.org)
  // rate-limits ("over rate limit") under load — the public-RPC starvation. Use a
  // configurable, reliable endpoint (ZBASE_BASE_RPC), defaulting to a public node with
  // saner limits than base.org. viem's http transport already retries with backoff.
  const rpcUrl =
    process.env.ZBASE_BASE_RPC ??
    (chain.id === base.id ? "https://base-rpc.publicnode.com" : undefined);
  const client = createPublicClient({ chain, transport: http(rpcUrl) });

  const balance = await getWalletBalance({
    mnemonic: getOrCreateSeed(),
    depositedEvents: data.events,
    // Recover change notes too (the withdrawal chain) so a seed restore rebuilds the
    // whole balance, not just deposits.
    withdrawals: data.withdrawals,
    maxIndex,
    // Chain truth, not a local flag: a wallet restored from a seed has no local
    // "withdrawn" record, so every spent note would otherwise look spendable.
    isSpent: async (nullifierHash) =>
      (await client.readContract({
        address: data.pool,
        abi: POOL_SPENT_ABI,
        functionName: "nullifierHashes",
        args: [BigInt(nullifierHash)],
      })) as boolean,
  });

  return { ...balance, pool: data.pool };
}

export async function walletBalance(args: z.infer<typeof walletBalanceSchema>): Promise<string> {
  const b = await loadWalletBalance(args.maxIndex ?? 50);

  return JSON.stringify(
    {
      balanceUSDC: formatUnits(b.atomic, 6),
      spendableNotes: b.spendable.length,
      // The pool spends ONE note per payment, so a total is not a spending limit.
      // Surfacing the largest note stops "balance is $10 but a $6 payment failed"
      // from looking like a bug.
      largestNoteUSDC: b.spendable[0] ? formatUnits(BigInt(b.spendable[0].value), 6) : "0",
      spentNotes: b.spent.length,
      recoveredFrom: "seed + on-chain commitments (no local note file)",
      note:
        b.spendable.length > 1
          ? "Each payment spends ONE note. A payment larger than the biggest single note will fail even if the total covers it."
          : undefined,
    },
    null,
    2,
  );
}
