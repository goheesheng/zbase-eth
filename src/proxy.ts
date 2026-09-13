/**
 * Shipment A.3 — Facilitator metadata hygiene  (+ docs-playground CORS)
 *
 * Next.js 16 allows exactly ONE request-interception file and it must be named
 * `proxy.ts`. This file therefore carries BOTH concerns that used to live in two
 * files (the second, src/middleware.ts, was removed — Next refuses to build when
 * both exist):
 *
 *   1. PRIVACY (money-critical): on the facilitator-adjacent routes a paying agent
 *      hits directly, strip identifying request metadata on the way IN and set
 *      cache/referrer/sniff/permissions headers on the way OUT. "We can't surveil
 *      what we don't have." Behaviour here is unchanged from the original proxy.ts.
 *
 *   2. DOCS CORS (read-only, additive): the Scalar "Send" button at docs.zbase.app
 *      is a different origin from the API (zbase.app), so the browser needs
 *      Access-Control-Allow-Origin before it can read the response. Granted ONLY
 *      for an explicit origin allowlist AND only on the exact read-only paths in
 *      CORS_PATHS below. A settle / withdraw / transfer / vault / cron / any
 *      money-moving route can NEVER be CORS-enabled here — CORS_PATHS is an exact
 *      Set, never a prefix or wildcard.
 *
 * IMPORTANT: this file MUST NOT log any of the stripped headers. Don't add
 * console.log statements that touch the original request.headers object. If you
 * need debug visibility later, log only non-identifying fields (method,
 * pathname, status).
 *
 * The matcher below is the UNION of both concerns' route sets; per-request the
 * privacy block is gated by isPrivacyPath() and the CORS block by CORS_PATHS, so
 * each route gets exactly the treatment it got before the two files were merged.
 * Matcher literals are statically analyzed at build time — keep them literal.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/* ─── 1. Privacy metadata hygiene ─────────────────────────────────────────── */

/**
 * Request headers that identify the caller (IP, UA, locale, referer, cookies).
 * Stripped on every matched privacy request so route handlers never observe them.
 *
 * Lower-cased because the Headers API normalizes names to lower-case.
 */
const STRIPPED_REQUEST_HEADERS = [
  "x-forwarded-for",
  "x-real-ip",
  "cf-connecting-ip",
  "true-client-ip",
  "user-agent",
  "accept-language",
  "referer",
  "cookie",
] as const;

/**
 * Response headers that prevent caching and leakage by intermediaries.
 */
const PRIVACY_RESPONSE_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store, no-cache, must-revalidate",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Permissions-Policy": "interest-cohort=()",
};

/**
 * The facilitator-adjacent routes that receive privacy treatment. Mirrors the
 * original proxy.ts matcher exactly (prefix patterns expanded to predicates) so
 * unioning the CORS-only routes into `config.matcher` below does not newly strip
 * headers on read-only endpoints that never had it.
 */
const PRIVACY_EXACT = new Set<string>([
  "/api/withdraw",
  "/api/asp-update",
  "/api/deposits/confirm",
  "/api/x402-pay",
  "/api/vault",
  "/api/zbase/privacy-check",
  "/api/zx402/privacy-check",
]);

function isPrivacyPath(pathname: string): boolean {
  if (PRIVACY_EXACT.has(pathname)) return true;
  // /api/facilitator/:path*  (includes the bare /api/facilitator)
  if (pathname === "/api/facilitator" || pathname.startsWith("/api/facilitator/")) return true;
  // /api/zbase/exposure-report/:path*  and  /api/zx402/exposure-report/:path*
  if (pathname.startsWith("/api/zbase/exposure-report/")) return true;
  if (pathname.startsWith("/api/zx402/exposure-report/")) return true;
  return false;
}

/* ─── 2. Docs-playground CORS (read-only allowlist) ───────────────────────── */

const ALLOWED_ORIGINS = new Set([
  "https://docs.zbase.app",
  "http://localhost:8000", // local `mkdocs serve`
  "http://127.0.0.1:8000",
]);

/**
 * EXACT read-only paths the docs playground may call cross-origin. Never widen
 * this to a prefix/wildcard; never add a route that requires spend secrets,
 * signed payloads, or moves funds.
 */
const CORS_PATHS = new Set<string>([
  "/api/facilitator/supported",
  "/api/health",
  "/api/anonymity-set",
  "/api/forwarding/postman",
  "/api/deposits/events",
  "/api/zx402/privacy-check",
]);

function corsHeaders(origin: string | null): Headers {
  const h = new Headers();
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    h.set("Access-Control-Allow-Origin", origin);
    h.set("Vary", "Origin");
    h.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    h.set("Access-Control-Allow-Headers", "Content-Type");
    h.set("Access-Control-Max-Age", "86400");
  }
  return h;
}

/* ─── Entry point ─────────────────────────────────────────────────────────── */

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const origin = request.headers.get("origin");
  const corsPath = CORS_PATHS.has(pathname);

  // CORS preflight for the docs-playground routes: browsers send OPTIONS before
  // a cross-origin POST / JSON GET. Answer directly, before anything else runs.
  if (corsPath && request.method === "OPTIONS") {
    return new NextResponse(null, { status: 204, headers: corsHeaders(origin) });
  }

  let response: NextResponse;

  if (isPrivacyPath(pathname)) {
    // Clone the incoming headers and remove the identifying ones. The cloned set
    // is what the downstream route handler reads via `request.headers`.
    const sanitizedHeaders = new Headers(request.headers);
    for (const name of STRIPPED_REQUEST_HEADERS) {
      sanitizedHeaders.delete(name);
    }
    // NextResponse.next({ request: { headers } }) is the documented way to mutate
    // the request the handler receives.
    response = NextResponse.next({ request: { headers: sanitizedHeaders } });
    // Apply privacy response headers on the way out.
    for (const [name, value] of Object.entries(PRIVACY_RESPONSE_HEADERS)) {
      response.headers.set(name, value);
    }
  } else {
    response = NextResponse.next();
  }

  // Docs-playground CORS response headers (only for allowlisted read-only paths).
  if (corsPath) {
    corsHeaders(origin).forEach((v, k) => response.headers.set(k, v));
  }

  return response;
}

// UNION of the privacy matcher and the docs-CORS matcher. Per-request gating
// (isPrivacyPath / CORS_PATHS) keeps each route's treatment identical to the
// pre-merge two-file behaviour. Literal strings only — statically analyzed.
export const config = {
  matcher: [
    // Privacy (facilitator-adjacent / money routes)
    "/api/facilitator/:path*",
    "/api/withdraw",
    "/api/asp-update",
    "/api/deposits/confirm",
    "/api/x402-pay",
    "/api/vault",
    "/api/zbase/privacy-check",
    "/api/zbase/exposure-report/:path*",
    "/api/zx402/privacy-check",
    "/api/zx402/exposure-report/:path*",
    // Docs-playground CORS (read-only) — those not already covered above
    "/api/health",
    "/api/anonymity-set",
    "/api/forwarding/postman",
    "/api/deposits/events",
  ],
};
