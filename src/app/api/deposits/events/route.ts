import { NextResponse } from "next/server";
import { createPublicClient, http, parseAbiItem } from "viem";
import { getActiveStack, getActiveChain } from "@/lib/contracts";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { hexBlock } from "@/lib/indexer";
import { hypersyncUrlFor, hypersyncToken } from "@/lib/hypersync";

/**
 * The pool's Deposited event. Decoded here rather than via asp-screening's
 * fetchDepositedEvents: that returns DepositedLog {depositor, label, txHash,
 * blockNumber} — it exists to screen depositors and carries NO commitment or value,
 * which are precisely the two fields recovery matches on.
 */
const DEPOSITED_EVENT = parseAbiItem(
  "event Deposited(address indexed _depositor, uint256 _commitment, uint256 _label, uint256 _value, uint256 _precommitmentHash)",
);

/**
 * Every leaf in the state tree, including CHANGE notes.
 *
 * A change note is inserted as a leaf but emits NO Deposited event — only this. That
 * asymmetry is why the two arrays below are not interchangeable, and it bounds what
 * seed-only recovery can do today. See the `leaves` note in the response.
 */
const LEAF_INSERTED_EVENT = parseAbiItem(
  "event LeafInserted(uint256 _index, uint256 _leaf, uint256 _root)",
);

/**
 * A pool withdrawal — the missing half of change-note recovery.
 *
 * `_spentNullifier` links the withdrawal to the note that funded it (a recovered
 * parent's nullifierHash); `_value` is the amount pushed out, so the change note's value
 * is `parent_value − _value` exactly (no change-side fee); `_newCommitment` IS the change
 * leaf, to verify the reconstruction against. Together with parent-keyed secrets this
 * makes change notes recoverable from the seed — closing the gap the `recovery` block
 * used to report as open.
 */
const WITHDRAWN_EVENT = parseAbiItem(
  "event Withdrawn(address indexed _processooor, uint256 _value, uint256 _spentNullifier, uint256 _newCommitment)",
);

export const maxDuration = 60;

/**
 * GET /api/deposits/events — the pool's `Deposited` commitments.
 *
 * A seed-recovering wallet needs these: it derives candidate notes from the seed and
 * matches them against on-chain commitments (recoverForwardingNotes). Without this it
 * cannot rebuild a balance, and "restore from 12 words" does not work — which is the
 * whole property that makes notes non-losable.
 *
 * A client cannot fetch these itself. The pool deploy block is ~130k blocks back and
 * browsers/agents use public RPCs, which cap eth_getLogs ranges. The server has
 * HyperSync and a real provider, so it does the scan.
 *
 * PRIVACY: this returns ONLY what is already public on-chain — commitment, label,
 * value — for the WHOLE pool, identical for every caller. It is deliberately not
 * filterable by address or commitment: a per-caller filter would tell the server which
 * commitments are yours, which is exactly the link the pool exists to break. Matching
 * happens client-side against the seed. The anonymity set is public by design; that is
 * what an anonymity set IS.
 */
export async function GET(request: Request) {
  try {
    // Unbounded chain scan — cheap for us to cache, expensive to serve in a loop.
    const rl = await checkRateLimit(request, "indexer-sync");
    if (!rl.success) return rateLimitResponse(rl);

    const stack = getActiveStack();
    const chain = getActiveChain();

    if (!stack.usdcPool || /^0x0{40}$/i.test(stack.usdcPool)) {
      return NextResponse.json(
        { error: `Pool not deployed on ${stack.facilitatorNetwork}.` },
        { status: 503 },
      );
    }

    // Prefer HyperSync (unbounded range, no per-range/rate caps) over the public RPC
    // (Infura), whose eth_getLogs 429s under load — the documented starvation that made
    // this balance-load path fail intermittently. Blocks are pre-hexed (hexBlock):
    // HyperSync rejects decimal block numbers. Falls back to a CHUNKED public-RPC scan
    // when this chain has no HyperSync entitlement (e.g. Ethereum Sepolia — our
    // HyperSync token is Base-only, see @/lib/hypersync) or no HYPERSYNC_TOKEN is set
    // (local dev); hex block numbers are accepted on the public RPC too.
    const hs = hypersyncUrlFor(chain.chain.id);
    const publicClient = createPublicClient({
      chain: chain.chain,
      transport: hs
        ? http(hs, { fetchOptions: { headers: { Authorization: `Bearer ${hypersyncToken()}` } } })
        : http(chain.readRpcUrl),
    });

    const deployBlock = BigInt(stack.poolDeployBlock);
    const fromBlock = hexBlock(deployBlock) as unknown as bigint;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async function fetchLogs(event: any) {
      if (hs) {
        return publicClient.getLogs({
          address: stack.usdcPool as `0x${string}`,
          event,
          fromBlock,
          toBlock: "latest",
        });
      }
      // RPC-fallback chunk size: LOG_CHUNK_BLOCKS env override, else the active
      // stack's per-chain cap (agent S1: 10_000 Base / 50_000 eth-sepolia —
      // measured eth_getLogs range caps), else 10_000. Public RPCs cap
      // eth_getLogs block ranges, so an unbounded single call (the HyperSync
      // path above) is not safe here.
      const chunkBlocks = BigInt(
        Number(process.env.LOG_CHUNK_BLOCKS ?? getActiveStack().logChunkBlocks ?? 10_000),
      );
      const currentBlock = await publicClient.getBlockNumber();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const all: any[] = [];
      for (let from = deployBlock; from <= currentBlock; from += chunkBlocks) {
        const to = from + chunkBlocks - 1n > currentBlock ? currentBlock : from + chunkBlocks - 1n;
        const chunkLogs = await publicClient.getLogs({
          address: stack.usdcPool as `0x${string}`,
          event,
          fromBlock: from,
          toBlock: to,
        });
        all.push(...chunkLogs);
      }
      return all;
    }

    const [depositLogs, leafLogs, withdrawLogs] = await Promise.all([
      fetchLogs(DEPOSITED_EVENT),
      fetchLogs(LEAF_INSERTED_EVENT),
      fetchLogs(WITHDRAWN_EVENT),
    ]);

    // Exactly the three fields recoverForwardingNotes matches on. NOT the depositor,
    // block, or tx hash: those are already public individually, but serving them as
    // one indexed list hands a caller ready-made correlation material — on a privacy
    // rail, "it's public anyway" is not a reason to make it convenient.
    const items = depositLogs.flatMap((l) => {
      const a = l.args as { _commitment?: bigint; _label?: bigint; _value?: bigint };
      if (a._commitment === undefined || a._label === undefined || a._value === undefined) return [];
      return [{ commitment: a._commitment.toString(), label: a._label.toString(), value: a._value.toString() }];
    });

    const leaves = leafLogs.flatMap((l) => {
      const a = l.args as { _index?: bigint; _leaf?: bigint };
      if (a._index === undefined || a._leaf === undefined) return [];
      return [{ index: Number(a._index), leaf: a._leaf.toString() }];
    });

    // The withdrawal chain. All three fields are already public on-chain; served together
    // so a seed-recovering wallet can walk deposits → changes without a per-caller query
    // (which would leak which notes are yours).
    const withdrawals = withdrawLogs.flatMap((l) => {
      const a = l.args as { _value?: bigint; _spentNullifier?: bigint; _newCommitment?: bigint };
      if (a._value === undefined || a._spentNullifier === undefined || a._newCommitment === undefined) return [];
      return [{
        value: a._value.toString(),
        spentNullifier: a._spentNullifier.toString(),
        newCommitment: a._newCommitment.toString(),
      }];
    });

    return NextResponse.json(
      {
        network: stack.facilitatorNetwork,
        pool: stack.usdcPool,
        count: items.length,
        events: items,
        leaves,
        withdrawals,
        /**
         * WHAT SEED-ONLY RECOVERY CAN DO — now closed for change notes too.
         *
         * `events` (Deposited) carry (commitment, label, value) — everything
         * recoverForwardingNotes needs to recover a DEPOSIT from the seed.
         *
         * `leaves` (LeafInserted) carry only (index, leaf) — a change note's value is
         * not in its own event, which is why change recovery used to be impossible.
         * `withdrawals` (Withdrawn) close that: each carries the spent parent's
         * nullifier, the value out, and the change commitment. So recoverChangeNotes
         * walks deposits → withdrawals, deriving each change note's SECRETS from its
         * parent (parent-keyed `deriveChangeNote`), its LABEL from the parent (ASP
         * propagation), and its VALUE as `parent_value − withdrawn_value`, then verifies
         * the reconstruction against `newCommitment`.
         *
         * Caveat: this works for change notes whose secrets were parent-keyed — i.e.
         * anything spent through the current SDK. A pre-fix LEGACY random change note
         * (secrets never seed-linked) stays unrecoverable; that is the already-lost
         * 0.985, and no data can bring it back.
         */
        recovery: {
          depositsRecoverableFromSeed: true,
          changeNotesRecoverableFromSeed: true,
          reason:
            "Change notes recover by walking Withdrawn events: secrets are parent-keyed (deriveChangeNote), label propagates from the parent, and value = parent_value − withdrawn_value, verified against newCommitment. Legacy pre-fix random change notes remain unrecoverable.",
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return NextResponse.json(
      { error: `Failed to read pool deposits: ${(e as Error).message.slice(0, 200)}` },
      { status: 500 },
    );
  }
}
