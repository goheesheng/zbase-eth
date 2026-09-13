/**
 * GET /api/anonymity-set
 *
 * Public anonymity-set composition dashboard data source.
 *
 * Reads `Deposited` events from the active Base USDC pool, partitions
 * each deposit into "seeded" (sent FROM the treasury address) vs
 * "organic" (everyone else), aggregates per-pool + growth windows, and
 * returns JSON.
 *
 * Disclosure ladder (see docs/seed-pool/risk-analysis-2026-05-31.md §3):
 *   organic <  30  -> mode = "bootstrap"  (totals only, ratios hidden)
 *   organic >= 30  -> mode = "raw"        (full per-pool seeded/organic)
 *
 * The bootstrap mode prevents broadcasting "100 seeded vs 3 organic",
 * which would shrink the effective anonymity set for the first organic
 * depositors. k=30 is the conventional unlinkability threshold.
 *
 * Caching: result is cached in-process for 60s. The route always returns
 * 200; clients read `disclosureMode` to choose presentation. RPC failure
 * falls back to last good cached value (if any) or zeros.
 *
 * Privacy contract:
 *   - Only public on-chain data is read. No request-side identifiers
 *     are stored. `src/proxy.ts` does not strip headers from this
 *     route (it's not a facilitator endpoint) but no PII is recorded.
 *   - Treasury address is intentionally public; that is the design.
 */

import { NextResponse } from "next/server";
import { createPublicClient, http, isAddress, getAddress, type PublicClient } from "viem";
import { getActiveChain, getActiveStack } from "@/lib/contracts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// --- pool registry ----------------------------------------------------------

const _stack = getActiveStack();
const USDC_POOL_ADDRESS = _stack.usdcPool;
const POOL_DEPLOY_BLOCK = _stack.poolDeployBlock;

// Capped to the last 50K blocks per the task spec — bounds RPC cost.
// Base Sepolia ~2s blocks => 50K blocks ~= 27.7h. The pool may have
// earlier deposits; those won't appear in the dashboard but DO appear in
// the on-chain ASP. This is a cost/freshness trade-off, not a correctness
// claim about the pool's total state.
const LOOKBACK_BLOCKS = 50_000n;

// Public-RPC eth_getLogs ceiling (10K on sepolia.base.org). 9999 is safe.
const MAX_BLOCK_RANGE = 9999n;
const CHUNK_DELAY_MS = 500;

// Pool labels reflect deployed-contract reality, not roadmap features.
// The deployed pool is a PLAIN 0xbow PrivacyPool with NO yield and NO Morpho
// integration — verified on-chain 2026-06-25: it reverts on every Morpho/yield
// getter (morpho/vault/totalYield/PROTOCOL_FEE_BPS) and ASSET() returns raw USDC.
// USDC sits in the pool contract itself. (A yield variant, PrivacyPoolMorpho.sol,
// exists on disk but was never deployed and is not on the roadmap.) See:
//   - CLAUDE.md "Deployed Contracts — plain 0xbow Privacy Pool (CURRENT)"
const POOLS: Array<{ address: `0x${string}`; label: string }> = [
  { address: USDC_POOL_ADDRESS, label: "USDC (0xbow PrivacyPool, no yield)" },
];

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

// --- disclosure threshold ---------------------------------------------------

/** k=30 — conventional anonymity-set lower bound (Tornado Cash research). */
const BOOTSTRAP_ORGANIC_THRESHOLD = 30;

// --- treasury address -------------------------------------------------------

function resolveTreasuryAddress(): `0x${string}` {
  const raw =
    process.env.NEXT_PUBLIC_TREASURY_ADDRESS ||
    "0xcDB447c3a352AD8ADF3D8d97Da9a3CF91880b843";
  if (!isAddress(raw)) {
    throw new Error(`Invalid NEXT_PUBLIC_TREASURY_ADDRESS: ${raw}`);
  }
  return getAddress(raw);
}

// --- types ------------------------------------------------------------------

type PerPoolRaw = {
  address: `0x${string}`;
  label: string;
  total: number;
  seeded: number;
  organic: number;
};

type DepositRecord = {
  pool: `0x${string}`;
  depositor: `0x${string}`;
  /**
   * Post-fee deposit value, atomic. The Deposited event has always carried this and
   * nothing ever read it — which is why a ZERO-VALUE deposit counted as anonymity.
   * With the entrypoint's minimumDepositAmount at 0, anyone could mint unlimited
   * commitments for the price of gas and inflate the organic count for free.
   */
  value: bigint;
  blockNumber: bigint;
  blockTime: number; // unix seconds, 0 if unknown
};

export type AnonymitySetResponse = {
  totalDeposits: number;
  seededDeposits: number;
  organicDeposits: number;
  perPool: Array<{
    address: `0x${string}`;
    label: string;
    total: number;
    /** present only when disclosureMode === "raw" */
    seeded?: number;
    /** present only when disclosureMode === "raw" */
    organic?: number;
  }>;
  growth7d:
    | { seeded: number; organic: number }
    | { total: number };
  growth30d:
    | { seeded: number; organic: number }
    | { total: number };
  disclosureMode: "raw" | "bootstrap";
  bootstrapThreshold: number;
  ts: string;
  blockRange: { from: number; to: number };
  treasuryAddress: `0x${string}`;
  /** populated only when an RPC failure forced us to serve stale data */
  staleSeconds?: number;
  /** populated only when an error occurred and no cache was available */
  error?: string;
};

// --- 60s in-memory cache ----------------------------------------------------

const CACHE_TTL_MS = 60_000;
let CACHE: { value: AnonymitySetResponse; expiresAt: number; key: string } | null = null;

// --- helpers ----------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Chunked eth_getLogs scan, mirroring the asp-update pattern. Public RPCs
 * cap range at 10K blocks and rate-limit aggressively, so we cap each chunk
 * and pause 500ms between chunks.
 */
async function fetchDepositsInRange(
  client: PublicClient,
  pool: `0x${string}`,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<DepositRecord[]> {
  const out: DepositRecord[] = [];
  for (let from = fromBlock; from <= toBlock; from += MAX_BLOCK_RANGE) {
    const to =
      from + MAX_BLOCK_RANGE - 1n > toBlock
        ? toBlock
        : from + MAX_BLOCK_RANGE - 1n;

    const chunk = await client.getLogs({
      address: pool,
      event: DEPOSITED_EVENT,
      fromBlock: from,
      toBlock: to,
    });

    for (const log of chunk) {
      const args = (log as unknown as {
        args: { _depositor: `0x${string}`; _value?: bigint };
      }).args;
      out.push({
        pool,
        depositor: getAddress(args._depositor),
        value: args._value ?? 0n,
        blockNumber: log.blockNumber ?? 0n,
        blockTime: 0,
      });
    }

    // Don't sleep after the final chunk
    if (to < toBlock) {
      await sleep(CHUNK_DELAY_MS);
    }
  }
  return out;
}

/**
 * Resolve block timestamps for the deposits we care about (growth windows).
 * Batches by unique block number to minimise RPC calls.
 */
async function attachBlockTimes(
  client: PublicClient,
  deposits: DepositRecord[],
): Promise<void> {
  const uniqueBlocks = Array.from(
    new Set(deposits.map((d) => d.blockNumber.toString())),
  ).map((s) => BigInt(s));

  // Sequential to be polite to free RPCs; this is cached for 60s anyway.
  const timeByBlock = new Map<string, number>();
  for (const bn of uniqueBlocks) {
    try {
      const block = await client.getBlock({ blockNumber: bn });
      timeByBlock.set(bn.toString(), Number(block.timestamp));
    } catch {
      timeByBlock.set(bn.toString(), 0);
    }
  }
  for (const d of deposits) {
    d.blockTime = timeByBlock.get(d.blockNumber.toString()) ?? 0;
  }
}

function countGrowth(
  deposits: DepositRecord[],
  treasury: `0x${string}`,
  windowSeconds: number,
  nowSeconds: number,
): { seeded: number; organic: number } {
  const since = nowSeconds - windowSeconds;
  let seeded = 0;
  let organic = 0;
  for (const d of deposits) {
    if (d.blockTime === 0 || d.blockTime < since) continue;
    if (d.depositor === treasury) seeded += 1;
    else organic += 1;
  }
  return { seeded, organic };
}

// --- main handler -----------------------------------------------------------

export async function GET() {
  const now = Date.now();
  const activeChain = getActiveChain();
  const cacheKey = `${activeChain.network}:${USDC_POOL_ADDRESS}:${POOL_DEPLOY_BLOCK}`;
  if (CACHE && CACHE.key === cacheKey && CACHE.expiresAt > now) {
    return NextResponse.json(CACHE.value, {
      headers: { "cache-control": "public, max-age=60" },
    });
  }

  const rpcUrl = activeChain.readRpcUrl;
  const rpcConfigured =
    activeChain.network === "mainnet"
      ? Boolean(process.env.BASE_MAINNET_RPC || process.env.NEXT_PUBLIC_BASE_MAINNET_RPC)
      : Boolean(process.env.BASE_SEPOLIA_RPC || process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC);
  if (!rpcConfigured) {
    const body: AnonymitySetResponse = emptyResponse(
      `${activeChain.network === "mainnet" ? "BASE_MAINNET_RPC" : "BASE_SEPOLIA_RPC"} not configured`,
    );
    return NextResponse.json(body, { status: 200 });
  }

  let treasury: `0x${string}`;
  try {
    treasury = resolveTreasuryAddress();
  } catch (err) {
    const body: AnonymitySetResponse = emptyResponse((err as Error).message);
    return NextResponse.json(body, { status: 200 });
  }

  try {
    // The workspace has two viem copies in node_modules (root pin
    // resolves separately from @zbase-protocol/core's pin), each exporting its
    // own incompatible PublicClient type. Cast to `unknown` then to the
    // root PublicClient to bridge the structurally-identical-but-
    // nominally-distinct types. Keeps the route stable until the
    // workspace dedupes viem to a single version.
    const client = createPublicClient({
      chain: activeChain.chain,
      transport: http(rpcUrl),
    }) as unknown as PublicClient;

    const head = await client.getBlockNumber();
    const fromBlock =
      head > LOOKBACK_BLOCKS && head - LOOKBACK_BLOCKS > POOL_DEPLOY_BLOCK
        ? head - LOOKBACK_BLOCKS
        : POOL_DEPLOY_BLOCK;

    const allDeposits: DepositRecord[] = [];
    const perPoolMap = new Map<`0x${string}`, PerPoolRaw>();
    for (const pool of POOLS) {
      perPoolMap.set(pool.address, {
        address: pool.address,
        label: pool.label,
        total: 0,
        seeded: 0,
        organic: 0,
      });
      const deps = await fetchDepositsInRange(client, pool.address, fromBlock, head);
      allDeposits.push(...deps);
    }

    // Tally per-pool totals
    for (const d of allDeposits) {
      const row = perPoolMap.get(d.pool);
      if (!row) continue;
      row.total += 1;
      if (d.depositor === treasury) row.seeded += 1;
      else row.organic += 1;
    }

    const totalDeposits = allDeposits.length;
    const seededDeposits = allDeposits.filter((d) => d.depositor === treasury).length;
    const organicDeposits = totalDeposits - seededDeposits;

    // Growth windows need block timestamps. Skip the timestamp fetch when
    // there are no deposits, to avoid pointless RPC calls.
    if (allDeposits.length > 0) {
      await attachBlockTimes(client, allDeposits);
    }
    const nowSeconds = Math.floor(Date.now() / 1000);
    const growth7dRaw = countGrowth(allDeposits, treasury, 7 * 24 * 3600, nowSeconds);
    const growth30dRaw = countGrowth(allDeposits, treasury, 30 * 24 * 3600, nowSeconds);

    const disclosureMode: "raw" | "bootstrap" =
      organicDeposits >= BOOTSTRAP_ORGANIC_THRESHOLD ? "raw" : "bootstrap";

    const perPool: AnonymitySetResponse["perPool"] = Array.from(perPoolMap.values()).map(
      (row) =>
        disclosureMode === "raw"
          ? { address: row.address, label: row.label, total: row.total, seeded: row.seeded, organic: row.organic }
          : { address: row.address, label: row.label, total: row.total },
    );

    const growth7d =
      disclosureMode === "raw"
        ? growth7dRaw
        : { total: growth7dRaw.seeded + growth7dRaw.organic };
    const growth30d =
      disclosureMode === "raw"
        ? growth30dRaw
        : { total: growth30dRaw.seeded + growth30dRaw.organic };

    const body: AnonymitySetResponse = {
      totalDeposits,
      seededDeposits: disclosureMode === "raw" ? seededDeposits : 0,
      organicDeposits: disclosureMode === "raw" ? organicDeposits : 0,
      perPool,
      growth7d,
      growth30d,
      disclosureMode,
      bootstrapThreshold: BOOTSTRAP_ORGANIC_THRESHOLD,
      ts: new Date().toISOString(),
      blockRange: { from: Number(fromBlock), to: Number(head) },
      treasuryAddress: treasury,
    };

    CACHE = { value: body, expiresAt: Date.now() + CACHE_TTL_MS, key: cacheKey };
    return NextResponse.json(body, {
      headers: { "cache-control": "public, max-age=60" },
    });
  } catch (err) {
    // Serve stale cache if we have it; otherwise an empty-but-shaped 200.
    if (CACHE && CACHE.key === cacheKey) {
      const ageSec = Math.round((Date.now() - (CACHE.expiresAt - CACHE_TTL_MS)) / 1000);
      const stale: AnonymitySetResponse = { ...CACHE.value, staleSeconds: ageSec };
      return NextResponse.json(stale, { status: 200 });
    }
    const body: AnonymitySetResponse = emptyResponse((err as Error).message);
    return NextResponse.json(body, { status: 200 });
  }
}

function emptyResponse(error: string): AnonymitySetResponse {
  const treasury = (() => {
    try {
      return resolveTreasuryAddress();
    } catch {
      return "0x0000000000000000000000000000000000000000" as `0x${string}`;
    }
  })();
  return {
    totalDeposits: 0,
    seededDeposits: 0,
    organicDeposits: 0,
    perPool: POOLS.map((p) => ({ address: p.address, label: p.label, total: 0 })),
    growth7d: { total: 0 },
    growth30d: { total: 0 },
    disclosureMode: "bootstrap",
    bootstrapThreshold: BOOTSTRAP_ORGANIC_THRESHOLD,
    ts: new Date().toISOString(),
    blockRange: { from: 0, to: 0 },
    treasuryAddress: treasury,
    error,
  };
}
