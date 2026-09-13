/**
 * Per-IP rate limiting for facilitator endpoints.
 *
 * Closes FIND-001 from the 2026-06-06 security audit: without this, an
 * attacker can spam /api/facilitator/authorize to exhaust the Base Sepolia
 * RPC quota (every call fires a getTransactionReceipt RPC request).
 *
 * Backend (auto-detected at module load):
 *
 *   1. Upstash Redis  — preferred. Sliding window counter, shared across
 *      all Vercel function instances. Provision via Vercel Marketplace;
 *      requires UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN.
 *
 *   2. In-memory     — fallback when Upstash env vars are absent. Per-
 *      instance counter, so under heavy concurrent load with multiple
 *      Vercel function instances a single IP can effectively hit the
 *      limit N times instead of once. Fine for local dev or pre-launch.
 *
 * Usage in a route handler:
 *
 *   const limited = await checkRateLimit(req, "authorize");
 *   if (!limited.success) return rateLimitResponse(limited);
 *   // ... rest of handler
 */

import { NextResponse } from "next/server";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

// Same fallback as facilitator-authz.ts — accept both Upstash standard
// names AND the Vercel Marketplace's auto-injected KV_REST_API_* names.
const UPSTASH_URL =
  process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
const UPSTASH_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
const USE_UPSTASH = Boolean(UPSTASH_URL && UPSTASH_TOKEN);

// One ratelimiter per route — different routes get different budgets.
// Sliding window: smooths bursts, more forgiving than fixed-window.
const limiters: Record<string, Ratelimit> = {};

function getLimiter(routeName: string): Ratelimit | null {
  if (!USE_UPSTASH) return null;
  if (!limiters[routeName]) {
    const config = ROUTE_LIMITS[routeName] ?? DEFAULT_LIMIT;
    limiters[routeName] = new Ratelimit({
      redis: new Redis({ url: UPSTASH_URL!, token: UPSTASH_TOKEN! }),
      limiter: Ratelimit.slidingWindow(config.requests, config.window),
      analytics: true,
      prefix: `zbase:rl:${routeName}`,
    });
  }
  return limiters[routeName];
}

// ── Per-route limits ─────────────────────────────────────────────
// authorize: each call fires a Base Sepolia RPC getTransactionReceipt.
// 10 req/min is plenty for a legit buyer (they make ONE /authorize per
// deposit), and tight enough to defeat RPC-budget exhaustion attacks.
//
// settle: heavier per-call (generates a Groth16 proof + on-chain settle).
// 30 req/min lets a single buyer make ~3 settles every 10 seconds, which
// matches realistic agent traffic patterns.
const DEFAULT_LIMIT = { requests: 60, window: "1 m" as const };
const ROUTE_LIMITS: Record<string, { requests: number; window: "1 m" | "10 s" | "1 h" }> = {
  // Global pre-RPC guard for /authorize. Route proxy strips IP headers by
  // design, so this protects Base RPC quota before the tx-hash idempotency
  // limiter below can be applied.
  "authorize-preflight": { requests: 120, window: "1 m" },
  authorize: { requests: 10, window: "1 m" },
  settle: { requests: 30, window: "1 m" },
  // vault: every call costs one signature verification (pure CPU, no RPC).
  // A legit client does 1 GET at unlock + 1 PUT per deposit/withdraw action;
  // 30/min per wallet leaves generous headroom while killing brute-force
  // bearer guessing and ciphertext-churn abuse.
  vault: { requests: 30, window: "1 m" },
  // asp-update: each call does an unbounded HyperSync log scan and may sign an
  // on-chain updateRoot (POSTMAN gas). Legit traffic is ~1 call per deposit, so
  // 10/min is ample while killing gas/RPC-exhaustion spam (audit F4).
  "asp-update": { requests: 10, window: "1 m" },
  // Sweep moves real funds (EIP-3009 receiveWithAuthorization -> pool deposit).
  // Keyed on the single-use nonce, never the address: keying on the payer would
  // build a per-user request log on a privacy rail. Soft guard only — USDC's own
  // authorizationState is the hard replay defence.
  sweep: { requests: 10, window: "1 m" },
  // Public deposit confirmation has a global pre-RPC bucket because an attacker
  // can vary fake hashes. Only a receipt proven to contain a real pool deposit
  // reaches the privileged ASP updater.
  "deposit-confirm-preflight": { requests: 60, window: "1 m" },
  // Bound retries/replays for one transaction independently from the global
  // RPC budget. Legit clients retry only while confirmations/indexing catch up.
  "deposit-confirm": { requests: 10, window: "1 m" },
  // indexer-sync: same class of work as asp-update (unbounded HyperSync log scan
  // + Redis writes). Cron fires every 10 min; manual after-deposit triggers are
  // occasional. 10/min kills RPC/Redis-exhaustion spam (security audit 2026-06-24,
  // Finding 3b) while leaving headroom.
  "indexer-sync": { requests: 10, window: "1 m" },
  // privacy-scan: the unauthenticated /api/{zx402,zbase}/{privacy-check,
  // exposure-report} routes each run analyzeWallet(), which does repeated Base
  // getLogs scans (~5 chunked RPC calls). Keyed on the target wallet address so
  // one address can't be re-scanned in a hot loop to burn RPC/CPU. 12/min is
  // generous for a human clicking "check my exposure" and tight against abuse
  // (codex adversarial review 2026-07-12).
  "privacy-scan": { requests: 12, window: "1 m" },
};

// In-memory fallback: per-route, per-IP counter with timestamp.
// Resets are coarser than the sliding-window Upstash impl but adequate
// for the fallback case (local dev or pre-Upstash launch).
type MemBucket = { count: number; resetAt: number };
const memBuckets: Map<string, MemBucket> = new Map();

function memCheck(
  routeName: string,
  identifier: string,
): { success: boolean; remaining: number; reset: number; limit: number } {
  const config = ROUTE_LIMITS[routeName] ?? DEFAULT_LIMIT;
  const windowMs = config.window === "10 s" ? 10_000 : config.window === "1 h" ? 3_600_000 : 60_000;
  const key = `${routeName}:${identifier}`;
  const now = Date.now();
  const bucket = memBuckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    const fresh: MemBucket = { count: 1, resetAt: now + windowMs };
    memBuckets.set(key, fresh);
    return {
      success: true,
      remaining: config.requests - 1,
      reset: fresh.resetAt,
      limit: config.requests,
    };
  }
  bucket.count += 1;
  return {
    success: bucket.count <= config.requests,
    remaining: Math.max(0, config.requests - bucket.count),
    reset: bucket.resetAt,
    limit: config.requests,
  };
}

// ── Public API ────────────────────────────────────────────────────
export type RateLimitResult = {
  success: boolean;
  remaining: number;
  reset: number;
  limit: number;
  backend: "upstash" | "memory";
};

/**
 * Extract a per-caller identifier. Priority:
 *   1. explicit `identifier` arg (preferred — e.g. nullifier on /settle,
 *      accessTokenTxHash on /authorize). Caller-supplied is best because
 *      it ties the rate limit to a privacy-relevant resource, not an IP.
 *   2. x-forwarded-for header (will be empty on routes covered by
   *      proxy.ts, which intentionally strips IP headers for privacy).
 *   3. x-real-ip
 *   4. sentinel "anonymous" — last-resort, means GLOBAL bucket (bad!),
 *      should be unreachable in production for any rate-limited route.
 *
 * The 2026-06-07 audit (FIND-100) caught the original implementation
 * relying solely on (2/3/4), which produced a global bucket because the
 * middleware strips IP headers on /api/facilitator/* before this code
 * sees them. Always pass an explicit identifier from rate-limited routes.
 */
function getClientId(req: Request, identifier?: string): string {
  if (identifier && identifier.length > 0) return identifier;
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  const xrip = req.headers.get("x-real-ip");
  if (xrip) return xrip.trim();
  return "anonymous";
}

export async function checkRateLimit(
  req: Request,
  routeName: string,
  identifier?: string,
): Promise<RateLimitResult> {
  const clientId = getClientId(req, identifier);
  const limiter = getLimiter(routeName);
  if (limiter) {
    const r = await limiter.limit(clientId);
    return {
      success: r.success,
      remaining: r.remaining,
      reset: r.reset,
      limit: r.limit,
      backend: "upstash",
    };
  }
  const r = memCheck(routeName, clientId);
  return { ...r, backend: "memory" };
}

export function rateLimitResponse(r: RateLimitResult): NextResponse {
  return NextResponse.json(
    {
      error: "Rate limit exceeded",
      detail: `Too many requests. Limit ${r.limit} per minute. Reset at ${new Date(r.reset).toISOString()}.`,
      retryAfterMs: Math.max(0, r.reset - Date.now()),
    },
    {
      status: 429,
      headers: {
        "Retry-After": String(Math.max(1, Math.ceil((r.reset - Date.now()) / 1000))),
        "X-RateLimit-Limit": String(r.limit),
        "X-RateLimit-Remaining": String(r.remaining),
        "X-RateLimit-Reset": String(r.reset),
      },
    },
  );
}
