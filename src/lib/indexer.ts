/**
 * indexer.ts — incremental, Redis-backed cache of the privacy pool's state-tree
 * leaves + ASP labels, so the settle/withdraw path stops re-scanning ALL chain
 * history and rebuilding the Merkle tree from genesis on every payment.
 *
 * Why this exists (facilitator-infra-architecture-2026-06-24.md, upgrade #1):
 * `withdraw/route.ts` fetched every `Deposited` + `LeafInserted` event and ran
 * `insertMany(allLeaves)` on EVERY settle — O(pool size) per payment, getting
 * slower as the pool grows. This makes the cost FLAT: the cache is advanced
 * incrementally on a trigger (cron), and settle reads it.
 *
 * Deploy reality: Cloudflare/Vercel serverless — no long-running process. So this
 * is NOT a daemon. It's a stateful cache in Upstash Redis that any request/cron
 * can advance. Workers are stateless; Redis is the shared state.
 *
 * Cache shape ("leaves only", the chosen fork): we store the ordered leaf list +
 * label list + a block cursor. The expensive thing was the CHAIN re-scan, not the
 * in-memory tree build (milliseconds for thousands of leaves), so callers load the
 * cached leaves and build the LeanIMT in memory. Smallest, safest cache.
 *
 * Correctness invariants:
 *  - Leaves are stored in on-chain `_index` order (the LeanIMT is order-dependent).
 *  - Sync is idempotent + append-only: re-running fetches only events past the
 *    cursor and appends; a leaf already at its index is never rewritten.
 *  - Callers SHOULD verify the cache-built root against the pool's on-chain
 *    `currentRoot` before trusting it for a money-moving proof (see
 *    `verifyCacheAgainstChain` usage notes). The cache is an optimization, not the
 *    source of truth — chain is.
 */

import { Redis } from "@upstash/redis";
import { LeanIMT } from "@zk-kit/lean-imt";
import { poseidon2 } from "poseidon-lite";

// ── Redis backend (same selection rule as facilitator-authz) ──────────────────
const UPSTASH_URL =
  process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
const UPSTASH_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
const redis =
  UPSTASH_URL && UPSTASH_TOKEN
    ? new Redis({ url: UPSTASH_URL, token: UPSTASH_TOKEN })
    : null;

export function indexerAvailable(): boolean {
  return redis !== null;
}

// ── Key namespace (per pool + network so stacks don't collide) ────────────────
const ns = (network: string, pool: string, suffix: string) =>
  `zbase:idx:${network}:${pool.toLowerCase()}:${suffix}`;
const LEAVES = (n: string, p: string) => ns(n, p, "leaves"); // Redis list, _index order
const LABELS = (n: string, p: string) => ns(n, p, "labels"); // Redis list, deposit order
const CURSOR = (n: string, p: string) => ns(n, p, "cursor"); // last-indexed block (string)
const META = (n: string, p: string) => ns(n, p, "meta"); // JSON {root,leafCount,updatedAt}

// ── Event ABIs (mirror withdraw/route.ts exactly) ─────────────────────────────
const DEPOSITED_EVENT = {
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
const LEAF_INSERTED_EVENT = {
  type: "event" as const,
  name: "LeafInserted" as const,
  inputs: [
    { name: "_index", type: "uint256" as const, indexed: false as const },
    { name: "_leaf", type: "uint256" as const, indexed: false as const },
    { name: "_root", type: "uint256" as const, indexed: false as const },
  ],
};

/**
 * A block number as a 0x-hex string for HyperSync's eth_getLogs.
 *
 * HyperSync's RPC-compat endpoint REJECTS decimal block numbers ("-32602: data did
 * not match any variant of untagged enum RpcBlockTag") where the plain Base RPC
 * tolerates them. viem 2.55 hex-encodes bigints correctly in isolation, but the
 * production Turbopack bundle was sending DECIMAL — so the indexer sync (and the
 * withdraw full-scan) 500'd against HyperSync and the cache never populated. We hex
 * the block ourselves with native BigInt.toString(16) (NOT viem's numberToHex, in
 * case the same bundling mangles it) and hand HyperSync a string it can't misread.
 * Verified in-container: hex → OK, decimal → the -32602 above.
 */
export const hexBlock = (b: bigint): `0x${string}` => `0x${b.toString(16)}`;

// Minimal structural type for the viem-ish client we accept (avoids a hard dep on
// the exact PublicClient generic — withdraw/route already constructs one). Blocks are
// pre-hexed strings (see hexBlock): HyperSync rejects decimal block numbers.
export interface LogClient {
  getLogs(args: {
    address: `0x${string}`;
    event: typeof DEPOSITED_EVENT | typeof LEAF_INSERTED_EVENT;
    fromBlock: `0x${string}`;
    toBlock: `0x${string}` | "latest";
  }): Promise<Array<{ args: Record<string, unknown>; blockNumber: bigint | null }>>;
}

export interface IndexerConfig {
  network: string; // facilitatorNetwork, e.g. "eip155:84532"
  pool: `0x${string}`; // usdcPool address
  deployBlock: bigint; // POOL_DEPLOY_BLOCK
  /**
   * Chunk size (blocks) for the log fetch below. Omit (or 0) for the default
   * single unbounded call — correct for a HyperSync client, which every
   * existing Base caller passes. Callers on a chain without a HyperSync
   * entitlement (e.g. Ethereum — see src/lib/hypersync.ts) pass a plain
   * eth_getLogs RPC client here instead, which caps its block range per call;
   * setting this splits the [fromBlock, latestBlock] window into chunks so
   * that cap is respected.
   */
  logChunkBlocks?: number;
}

export interface IndexerState {
  leaves: bigint[]; // state-tree leaves in _index order
  labels: bigint[]; // ASP labels in deposit order
  cursor: bigint; // last fully-indexed block
  leafCount: number;
}

const hash = (a: bigint, b: bigint) => poseidon2([a, b]);

// ──────────────────────────────────────────────────────────────────────────────
// Incremental sync — fetch events past the cursor, append, advance cursor.
// Returns the new state. Idempotent: safe to call repeatedly / concurrently
// (worst case two syncs fetch the same window; appends are dedup'd by index).
// ──────────────────────────────────────────────────────────────────────────────
export async function syncIndexer(
  client: LogClient,
  cfg: IndexerConfig,
  latestBlock: bigint,
): Promise<IndexerState & { fetchedFrom: bigint; appendedLeaves: number }> {
  if (!redis) throw new Error("indexer: Upstash not configured (UPSTASH_REDIS_REST_*)");

  const { network, pool, deployBlock } = cfg;
  const cursorRaw = await redis.get<string>(CURSOR(network, pool));
  // Start one past the last-indexed block; first run starts at deployBlock.
  const fromBlock = cursorRaw ? BigInt(cursorRaw) + 1n : deployBlock;

  // Nothing new.
  if (fromBlock > latestBlock) {
    const state = await readIndexer(cfg);
    return { ...state, fetchedFrom: fromBlock, appendedLeaves: 0 };
  }

  // Fetch the incremental window only. Blocks pre-hexed for HyperSync (hexBlock).
  const fromHex = hexBlock(fromBlock);
  const toHex = hexBlock(latestBlock);

  // Chunked fetch for RPC-fallback callers (cfg.logChunkBlocks set — no HyperSync
  // entitlement on this chain); a single unbounded call otherwise, unchanged from
  // before this option existed.
  const fetchAll = async (
    event: typeof LEAF_INSERTED_EVENT | typeof DEPOSITED_EVENT,
  ): Promise<Array<{ args: Record<string, unknown>; blockNumber: bigint | null }>> => {
    if (!cfg.logChunkBlocks) {
      return client.getLogs({ address: pool, event, fromBlock: fromHex, toBlock: toHex });
    }
    const step = BigInt(cfg.logChunkBlocks);
    const all: Array<{ args: Record<string, unknown>; blockNumber: bigint | null }> = [];
    for (let from = fromBlock; from <= latestBlock; from += step) {
      const to = from + step - 1n > latestBlock ? latestBlock : from + step - 1n;
      const chunkLogs = await client.getLogs({
        address: pool,
        event,
        fromBlock: hexBlock(from),
        toBlock: hexBlock(to),
      });
      all.push(...chunkLogs);
    }
    return all;
  };

  const [leafLogs, depositLogs] = await Promise.all([
    fetchAll(LEAF_INSERTED_EVENT),
    fetchAll(DEPOSITED_EVENT),
  ]);

  // Order leaves by their on-chain _index (LeanIMT is order-dependent). Within a
  // block getLogs is already in emit order, but sort defensively across the window.
  const newLeaves = leafLogs
    .map((l) => ({
      index: Number((l.args as { _index: bigint })._index),
      leaf: (l.args as { _leaf: bigint })._leaf,
    }))
    .sort((a, b) => a.index - b.index);
  const newLabels = depositLogs.map((l) => (l.args as { _label: bigint })._label);

  // Idempotent append-only. Both lists are append-only on-chain (leaves by
  // _index, deposits/labels in emit order). We only append entries BEYOND what's
  // already stored, keyed on the current list length — so a re-scanned/overlapping
  // window (retry, or a crash between rpush and cursor-set, or a concurrent sync)
  // never double-writes. Leaves carry an explicit _index; labels are positional.
  const existingLeafCount = await redis.llen(LEAVES(network, pool));
  const leavesToAppend = newLeaves
    .filter((x) => x.index >= existingLeafCount)
    .map((x) => x.leaf.toString());

  // Labels (ASP tree): deposits are append-only and emitted in order. The window
  // is strictly past the cursor, so in the normal path every label here is new.
  // Labels lack an on-chain index event, so unlike leaves they can't be
  // position-deduped on a re-fetch. We mitigate two ways: (1) the cursor advances
  // only AFTER both appends succeed, so a clean retry never re-fetches a committed
  // window; (2) settle verifies the cache-built STATE root against on-chain
  // `currentRoot` (cacheRootMatches) and falls back to a full chain scan if it
  // diverges — so a corrupted label list can't silently produce a bad proof.
  // A divergence is fully recoverable by `resetIndexer` (reseed from genesis).
  const labelsToAppend = newLabels.map((x) => x.toString());

  if (leavesToAppend.length > 0) {
    await redis.rpush(LEAVES(network, pool), ...leavesToAppend);
  }
  if (labelsToAppend.length > 0) {
    await redis.rpush(LABELS(network, pool), ...labelsToAppend);
  }

  // Advance the cursor LAST — only after appends succeed. A crash before this
  // line just means the next sync re-fetches the window (idempotent for leaves).
  await redis.set(CURSOR(network, pool), latestBlock.toString());

  const state = await readIndexer(cfg);
  // Recompute + cache the root for cheap staleness checks.
  const tree = new LeanIMT<bigint>(hash);
  if (state.leaves.length > 0) tree.insertMany(state.leaves);
  await redis.set(
    META(network, pool),
    JSON.stringify({
      root: state.leaves.length > 0 ? tree.root.toString() : "0",
      leafCount: state.leaves.length,
      updatedAt: latestBlock.toString(),
    }),
  );

  return { ...state, fetchedFrom: fromBlock, appendedLeaves: leavesToAppend.length };
}

// ──────────────────────────────────────────────────────────────────────────────
// Read the cached state (leaves + labels + cursor). O(cache size) one-shot read,
// NO chain access. Returns empty state if the cache is cold.
// ──────────────────────────────────────────────────────────────────────────────
export async function readIndexer(cfg: IndexerConfig): Promise<IndexerState> {
  if (!redis) throw new Error("indexer: Upstash not configured");
  const { network, pool } = cfg;
  const [leafStrs, labelStrs, cursorRaw] = await Promise.all([
    redis.lrange<string>(LEAVES(network, pool), 0, -1),
    redis.lrange<string>(LABELS(network, pool), 0, -1),
    redis.get<string>(CURSOR(network, pool)),
  ]);
  const leaves = (leafStrs ?? []).map((s) => BigInt(s));
  const labels = (labelStrs ?? []).map((s) => BigInt(s));
  return {
    leaves,
    labels,
    cursor: cursorRaw ? BigInt(cursorRaw) : 0n,
    leafCount: leaves.length,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Build the state + ASP LeanIMT from the cached leaves/labels. This is the
// drop-in replacement for withdraw's full-rescan + insertMany.
// ──────────────────────────────────────────────────────────────────────────────
export function buildTreesFromState(state: IndexerState): {
  stateTree: LeanIMT<bigint>;
  aspTree: LeanIMT<bigint>;
} {
  const stateTree = new LeanIMT<bigint>(hash);
  if (state.leaves.length > 0) stateTree.insertMany(state.leaves);
  const aspTree = new LeanIMT<bigint>(hash);
  if (state.labels.length > 0) aspTree.insertMany(state.labels);
  return { stateTree, aspTree };
}

// ──────────────────────────────────────────────────────────────────────────────
// Safety: the cache is an optimization, not the source of truth. A caller about to
// generate a money-moving proof should confirm the cache-built root equals the
// pool's live on-chain `currentRoot`. If it doesn't (cache stale/cold), the caller
// must fall back to a fresh chain scan. This returns whether the cache is trusted.
// ──────────────────────────────────────────────────────────────────────────────
export function cacheRootMatches(state: IndexerState, onchainRoot: bigint): boolean {
  if (state.leaves.length === 0) return onchainRoot === 0n;
  const tree = new LeanIMT<bigint>(hash);
  tree.insertMany(state.leaves);
  return tree.root === onchainRoot;
}

/**
 * Same trust check for the ASP/label tree (security audit 2026-06-24, Finding 4).
 * Labels lack an on-chain `_index` event, so unlike leaves they can be duplicated
 * by a concurrent sync — which would yield a wrong ASP root and wedge withdrawals.
 * The leaf-root check (`cacheRootMatches`) does NOT cover labels, so callers must
 * ALSO verify the cached labels reproduce the pool entrypoint's on-chain ASP root
 * (`latestRoot`) before trusting them; on divergence, fall back to a chain scan.
 */
export function cacheLabelsMatch(state: IndexerState, onchainAspRoot: bigint): boolean {
  if (state.labels.length === 0) return onchainAspRoot === 0n;
  const tree = new LeanIMT<bigint>(hash);
  tree.insertMany(state.labels);
  return tree.root === onchainAspRoot;
}

/**
 * Wipe the cache for a pool so the next `syncIndexer` reseeds from `deployBlock`.
 * Use when the root check fails (corruption) or after a contract redeploy. Cheap
 * and safe — the cache is derived state, never the source of truth.
 */
export async function resetIndexer(cfg: IndexerConfig): Promise<void> {
  if (!redis) throw new Error("indexer: Upstash not configured");
  const { network, pool } = cfg;
  await Promise.all([
    redis.del(LEAVES(network, pool)),
    redis.del(LABELS(network, pool)),
    redis.del(CURSOR(network, pool)),
    redis.del(META(network, pool)),
  ]);
}
