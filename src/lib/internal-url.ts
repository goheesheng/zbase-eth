/**
 * Base URL for server-to-server calls this app makes to its OWN routes
 * (settle → /api/withdraw, x402-pay → /api/withdraw, ...).
 *
 * Why this exists — `request.url` is NOT usable for a self-call on the
 * self-hosted Docker deployment:
 *
 *   1. proxy.ts runs on /api/facilitator/:path*, /api/withdraw and /api/x402-pay,
 *      and calls NextResponse.next({ request: { headers } }) to strip identifying
 *      headers. That makes Next re-dispatch the request internally, so the route
 *      handler observes the INTERNAL origin (http://localhost:3000/...) rather
 *      than the public host Caddy sent (zbase.app).
 *   2. The standalone server binds 0.0.0.0 — IPv4 only, no IPv6 listener.
 *   3. The container's /etc/hosts maps `::1 localhost`, and Node >=17 uses
 *      verbatim DNS ordering, so `localhost` resolves to ::1 FIRST.
 *
 * Net effect: `fetch(new URL("/api/withdraw", request.url))` dials [::1]:3000,
 * is refused instantly, and surfaces as the opaque undici error "fetch failed" —
 * which settle-x402 passes straight back to the buyer. Every settlement path is
 * dead on the VPS while looking fine on Vercel (where each route is its own
 * lambda and request.url IS the public URL).
 *
 * So: self-hosted sets ZBASE_INTERNAL_BASE_URL=http://127.0.0.1:3000 (explicit
 * IPv4 loopback — no DNS, no TLS, no NAT hairpin, no Caddy round-trip for what
 * is a local call). Vercel leaves it UNSET and keeps the request.url behavior,
 * which is the only thing that works there.
 */
export function internalBaseUrl(request: Request): string {
  const configured = process.env.ZBASE_INTERNAL_BASE_URL?.trim();
  if (configured) return configured;
  return request.url;
}

/** Resolve an absolute URL for one of this app's own routes. */
export function internalUrl(request: Request, path: string): string {
  return new URL(path, internalBaseUrl(request)).toString();
}
