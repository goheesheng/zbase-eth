import { NextResponse } from "next/server";
import { createPublicClient, http } from "viem";
import { getActiveStack, getActiveChain } from "@/lib/contracts";
import {
  syncIndexer,
  indexerAvailable,
  type IndexerConfig,
  type LogClient,
} from "@/lib/indexer";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { hypersyncUrlFor, hypersyncToken } from "@/lib/hypersync";

/**
 * GET/POST /api/cron/indexer-sync — advance the Redis-backed state-tree cache.
 *
 * Triggered on a schedule (vercel.json crons) and/or after deposits. Fetches
 * pool events since the last-indexed block and appends them to the cache, so the
 * settle/withdraw path can read the tree instead of re-scanning all chain history
 * per payment (facilitator-infra-architecture-2026-06-24.md, upgrade #1).
 *
 * Read-only on-chain (getLogs + block number); writes only to Upstash. Safe to
 * call repeatedly — syncIndexer is idempotent/append-only. Secret-gated like
 * /api/asp-update (Vercel cron sends the CRON_SECRET as a Bearer token).
 *
 * Uses HyperSync for unbounded log queries on chains it's entitled to (Base +
 * Base Sepolia today — see src/lib/hypersync.ts). On a chain without an
 * entitlement (e.g. Ethereum), falls back to a CHUNKED scan on the plain RPC —
 * syncIndexer does the chunking internally via IndexerConfig.logChunkBlocks.
 */

async function handle(request: Request) {
  try {
    // Auth — FAIL CLOSED in production (security audit 2026-06-24, Finding 3a).
    // Vercel cron sends `Authorization: Bearer <CRON_SECRET>`. This route does an
    // unbounded HyperSync log scan + Redis writes, so a public hit is a DoS
    // surface. Previously it only required the secret IF one was set — i.e. it
    // failed OPEN when unset. Now: in production a secret is MANDATORY (refuse if
    // missing); outside production (local dev) the open path is allowed for
    // convenience. This removes the dependency on an env var being remembered.
    const secret = process.env.INDEXER_SYNC_SECRET ?? process.env.CRON_SECRET;
    const isProd = process.env.NODE_ENV === "production";
    if (isProd && !secret) {
      return NextResponse.json(
        { error: "indexer-sync is locked: set INDEXER_SYNC_SECRET or CRON_SECRET in the production env." },
        { status: 503 },
      );
    }
    if (secret) {
      const auth = request.headers.get("authorization");
      if (auth !== `Bearer ${secret}`) {
        return NextResponse.json({ error: "unauthorized" }, { status: 401 });
      }
    }

    const limited = await checkRateLimit(request, "indexer-sync");
    if (!limited.success) return rateLimitResponse(limited);

    if (!indexerAvailable()) {
      return NextResponse.json(
        { error: "Indexer cache requires Upstash (UPSTASH_REDIS_REST_URL + TOKEN)." },
        { status: 503 },
      );
    }

    const stack = getActiveStack();
    const ZERO = "0x0000000000000000000000000000000000000000";
    if (stack.usdcPool === ZERO || stack.poolDeployBlock === 0n) {
      return NextResponse.json(
        { error: "Active stack has no deployed pool (usdcPool/poolDeployBlock unset)." },
        { status: 503 },
      );
    }

    const activeChain = getActiveChain();

    // HyperSync client for the log fetch (no block-range limits) — only when this
    // chain is HyperSync-entitled. `hs` is null on a chain our token can't reach
    // (e.g. Ethereum — see src/lib/hypersync.ts), in which case we scan the plain
    // RPC instead, chunked via cfg.logChunkBlocks below (syncIndexer honors it).
    const hs = hypersyncUrlFor(activeChain.chain.id);
    const hyperClient = hs
      ? createPublicClient({
          chain: activeChain.chain,
          transport: http(hs, {
            fetchOptions: { headers: { Authorization: `Bearer ${hypersyncToken()}` } },
          }),
        })
      : null;
    // Plain RPC for the latest block number (cheap, and HyperSync's tip may lag),
    // and — when hs is null — for the chunked log-scan fallback too.
    const rpcClient = createPublicClient({
      chain: activeChain.chain,
      transport: http(activeChain.readRpcUrl),
    });

    const latestBlock = await rpcClient.getBlockNumber();

    const cfg: IndexerConfig = {
      network: stack.facilitatorNetwork,
      pool: stack.usdcPool,
      deployBlock: stack.poolDeployBlock,
      // Only the RPC-fallback path needs chunking; HyperSync has no range cap.
      logChunkBlocks: hs
        ? undefined
        : Number(process.env.LOG_CHUNK_BLOCKS ?? stack.logChunkBlocks ?? 10_000),
    };

    const result = await syncIndexer(
      (hyperClient ?? rpcClient) as unknown as LogClient,
      cfg,
      latestBlock,
    );

    return NextResponse.json({
      ok: true,
      network: cfg.network,
      pool: cfg.pool,
      fetchedFrom: result.fetchedFrom.toString(),
      latestBlock: latestBlock.toString(),
      appendedLeaves: result.appendedLeaves,
      leafCount: result.leafCount,
      labelCount: result.labels.length,
      cursor: result.cursor.toString(),
    });
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message?.slice(0, 300) || "indexer sync failed" },
      { status: 500 },
    );
  }
}

// Vercel cron issues GET; allow POST too for manual/after-deposit triggers.
export const GET = handle;
export const POST = handle;
