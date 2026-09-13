/**
 * GET /api/health
 *
 * Deterministic 200/503 health check for external monitoring and the
 * scripts/test-stealth-roundtrip.sh boot probe.
 *
 *   - 200 OK     : all three configuration checks pass
 *   - 503        : at least one required env var is missing
 *
 * Privacy contract:
 *   - NEVER returns the actual key/secret values, only boolean presence.
 *   - NEVER logs env values, even partially.
 *   - `src/proxy.ts` does NOT match `/api/health`, so no facilitator
 *     metadata stripping applies here; this route is intentionally cheap
 *     and observable. Audited 2026-05-31.
 *
 * Style notes:
 *   - `dynamic = 'force-dynamic'` so the route is never statically cached.
 *   - `runtime = 'nodejs'` to match other routes in src/app/api/ that read
 *     process.env / shell out (e.g. /api/interest).
 *   - Git short SHA resolved ONCE at module load to avoid spawning a child
 *     process per request.
 */

import { NextResponse } from "next/server";
import { execFileSync } from "node:child_process";
import { contractStackLaunchIssues, getActiveChain, getActiveStack } from "@/lib/contracts";
import { getFacilitatorReadiness } from "@/lib/facilitator-readiness";
import { postmanSignerConfigIssues } from "@/lib/postman-signer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Resolved once at module load.
// Prefer Vercel's build-injected env var (containers have no git CLI), then
// generic deploy-platform SHAs (Netlify, Railway), then fall back to local
// `git rev-parse` for dev. Result: real SHA on prod, real SHA on dev,
// "unknown" only in truly headless environments.
const GIT_SHA: string = (() => {
  const fromEnv =
    process.env.VERCEL_GIT_COMMIT_SHA ??
    process.env.COMMIT_REF ??
    process.env.RAILWAY_GIT_COMMIT_SHA ??
    process.env.GIT_COMMIT_SHA;
  if (fromEnv) return fromEnv.slice(0, 7);
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      stdio: ["pipe", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
})();

export async function GET() {
  const startMs = Date.now();
  const stack = getActiveStack();
  const activeChain = getActiveChain();
  const stackIssues = contractStackLaunchIssues(stack);
  const signerIssues = postmanSignerConfigIssues();
  const rpcConfigured =
    activeChain.network === "mainnet"
      ? Boolean(process.env.BASE_MAINNET_RPC || process.env.NEXT_PUBLIC_BASE_MAINNET_RPC)
      : activeChain.network === "eth-sepolia"
        ? Boolean(process.env.ETH_SEPOLIA_RPC || process.env.NEXT_PUBLIC_ETH_SEPOLIA_RPC)
        : Boolean(process.env.BASE_SEPOLIA_RPC || process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC);
  const checks = {
    encKeyConfigured: Boolean(process.env.ZBASE_SEED_ENCRYPTION_KEY),
    postmanConfigured: signerIssues.length === 0,
    rpcConfigured,
    stackConfigured: stackIssues.length === 0,
    aspAuthConfigured: process.env.NODE_ENV !== "production" || Boolean(process.env.ASP_UPDATE_SECRET || process.env.CRON_SECRET),
  };

  const readiness = await getFacilitatorReadiness();
  const allOk =
    checks.encKeyConfigured &&
    checks.postmanConfigured &&
    checks.rpcConfigured &&
    checks.stackConfigured &&
    checks.aspAuthConfigured &&
    readiness.gates.chainReachable;

  // Backward-compat union: returns BOTH the new shape AND the legacy
  // fields the previous /api/health on main exposed. Removing the legacy
  // fields would break any external monitor / status page parsing them.
  // Keep the union until at least 2026-09-01, then revisit if no consumers
  // remain.
  return NextResponse.json(
    {
      // === New shape (post-2026-05-31 deploy) ===
      status: allOk ? "ok" : "degraded",
      version: "zBase",
      git: GIT_SHA,
      uptimeSec: Math.round(process.uptime()),
      checks,
      issues: {
        stack: stackIssues,
        postman: signerIssues,
        readiness: readiness.blockingReasons,
      },
      verificationReady: readiness.verificationReady,
      pilotReady: readiness.pilotReady,
      customerReady: readiness.customerReady,
      readiness: {
        verificationReady: readiness.verificationReady,
        // A tier honoured by some consumers and not others recreates the dishonesty the
        // tier removes — so /health reports it too. There is no separate "enabled": if the
        // stack can settle safely, it settles (and discloses). See src/lib/pilot.ts.
        pilotReady: readiness.pilotReady,
        customerReady: readiness.customerReady,
        organicAnonymitySet: readiness.organicAnonymitySet,
        minimumAnonymitySet: readiness.minimumAnonymitySet,
        blockingReasons: readiness.blockingReasons,
        assetConfig: readiness.assetConfig,
        indexer: readiness.indexer,
        gates: readiness.gates,
      },
      stack: stack.label,
      ts: new Date().toISOString(),

      // === Legacy shape (pre-2026-05-31, kept for backward compat) ===
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      latencyMs: Date.now() - startMs,
      network: activeChain.network === "mainnet" ? "base-mainnet" : "base-sepolia",
      facilitatorNetwork: stack.facilitatorNetwork,
      blockNumber: readiness.blockNumber,
      entrypoint: stack.entrypoint,
      privacyPool: stack.usdcPool,
      anonymitySet: readiness.anonymitySet,
      latestAspRoot: readiness.latestAspRoot,
    },
    { status: allOk ? 200 : 503 },
  );
}
