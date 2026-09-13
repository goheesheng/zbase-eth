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
 */

// Uses HyperSync for unbounded log queries (same endpoint withdraw uses).
const HYPERSYNC_TOKEN = process.env.HYPERSYNC_TOKEN;

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
    if (!HYPERSYNC_TOKEN) {
      return NextResponse.json({ error: "Missing HYPERSYNC_TOKEN" }, { status: 500 });
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

    // HyperSync client for the log fetch (no block-range limits).
    const hyperSyncUrl =
      activeChain.network === "mainnet"
        ? "https://base.rpc.hypersync.xyz"
        : "https://base-sepolia.rpc.hypersync.xyz";
    const hyperClient = createPublicClient({
      chain: activeChain.chain,
      transport: http(hyperSyncUrl, {
        fetchOptions: { headers: { Authorization: `Bearer ${HYPERSYNC_TOKEN}` } },
      }),
    });
    // Plain RPC for the latest block number (cheap, and HyperSync's tip may lag).
    const rpcClient = createPublicClient({
      chain: activeChain.chain,
      transport: http(activeChain.readRpcUrl),
    });

    const latestBlock = await rpcClient.getBlockNumber();

    const cfg: IndexerConfig = {
      network: stack.facilitatorNetwork,
      pool: stack.usdcPool,
      deployBlock: stack.poolDeployBlock,
    };

    const result = await syncIndexer(hyperClient as unknown as LogClient, cfg, latestBlock);

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
