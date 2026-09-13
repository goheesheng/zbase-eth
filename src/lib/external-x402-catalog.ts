/**
 * Mirror of third-party x402-paid endpoints that zBase can route privately.
 *
 * Today, the only catalogued source is SAN Foundation
 * (https://gateway.sanfoundation.com). SAN exposes both API-key endpoints
 * (`/api/v1/...`) and pay-per-call x402 endpoints (`/x402/v1/...`). We
 * fetch the API-key catalog (cheaper, no per-request charge) and project
 * each entry into both its API-key and x402 form.
 *
 * Best-effort: SAN going down or changing shape must NOT break zBase's
 * own facilitator API. The fetch is wrapped in a wide try/catch and
 * falls back to a curated hard-coded shortlist if no key is available
 * or the network call fails.
 *
 * In-memory cache with a 1-hour TTL. Resets on server restart, which is
 * fine — `/api/zx402/supported` is read-only and idempotent.
 */

export interface ThirdPartyEndpoint {
  /** Provider key, e.g. "san". */
  provider: string;
  /** Human-readable agent / endpoint name. */
  name: string;
  /** Stable identifier in the provider's namespace, e.g. SAN's `slug`. */
  ref?: string;
  /** Free-text description. */
  description: string;
  /** API-key URL form, if known. */
  apiUrl?: string;
  /** x402 (paid) URL form, if known. */
  x402Url?: string;
  /** Network identifier the x402 call settles on, e.g. "eip155:8453". */
  networkId?: string;
  /** Quoted price per call, e.g. "$0.0001". */
  price?: string;
}

interface CacheEntry {
  expires: number;
  endpoints: ThirdPartyEndpoint[];
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const SAN_GATEWAY = "https://gateway.sanfoundation.com";

let cache: CacheEntry | null = null;

/**
 * Hard-coded fallback returned when no SAN_API_KEY is set or when a
 * remote fetch fails. Kept short on purpose — these are the endpoints
 * zBase can prove it knows about without any external dependency.
 */
// Prices below come from the live `payment-required` header on SAN's
// challenge response (NOT from their docs page, which lists $0.0001 — the
// on-chain `amount` is currently 10000 atomic USDC = $0.01 for /agents).
// Verified 2026-05-09 via curl -D against gateway.sanfoundation.com.
const SAN_FALLBACK: ThirdPartyEndpoint[] = [
  {
    provider: "san",
    name: "SAN — list agents",
    ref: "agents",
    description:
      "Catalog of autonomous-machine intelligence agents (world-state, web search, web extract).",
    apiUrl: `${SAN_GATEWAY}/api/v1/agents`,
    x402Url: `${SAN_GATEWAY}/x402/v1/agents`,
    networkId: "eip155:8453",
    price: "$0.01",
  },
  {
    provider: "san",
    name: "SAN — web search",
    ref: "web-search",
    description: "Open-web search returning ranked results (up to 10).",
    apiUrl: `${SAN_GATEWAY}/api/v1/web-search`,
    x402Url: `${SAN_GATEWAY}/x402/v1/web-search`,
    networkId: "eip155:8453",
  },
  {
    provider: "san",
    name: "SAN — web extract",
    ref: "web-extract",
    description: "Fetch and extract the readable content of a single URL.",
    apiUrl: `${SAN_GATEWAY}/api/v1/web-extract`,
    x402Url: `${SAN_GATEWAY}/x402/v1/web-extract`,
    networkId: "eip155:8453",
  },
];

/**
 * Fetch SAN's agent catalog with the API-key path. Returns the fallback
 * if no key is configured, the network fails, or the response shape is
 * unexpected. Never throws — the only call site is a discovery endpoint
 * that should always render.
 */
async function fetchSanCatalog(): Promise<ThirdPartyEndpoint[]> {
  const key = process.env.SAN_API_KEY;
  if (!key) return SAN_FALLBACK;

  try {
    const res = await fetch(`${SAN_GATEWAY}/api/v1/agents`, {
      headers: { "x-api-key": key },
      // 4-second timeout; we'd rather render the fallback than block discovery.
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return SAN_FALLBACK;
    const body = (await res.json()) as { items?: unknown[]; agents?: unknown[] };
    // SAN's response shape isn't fully documented — be defensive.
    const items = Array.isArray(body.items)
      ? body.items
      : Array.isArray(body.agents)
        ? body.agents
        : [];
    if (items.length === 0) return SAN_FALLBACK;
    const projected = items
      .map((it) => projectSanAgent(it))
      .filter((x): x is ThirdPartyEndpoint => x !== null);
    return projected.length > 0 ? projected : SAN_FALLBACK;
  } catch {
    // Network or parse failure. Discovery never breaks for callers.
    return SAN_FALLBACK;
  }
}

/**
 * Map one SAN agent record into ThirdPartyEndpoint shape. Returns null
 * for records missing the minimum fields we need.
 */
function projectSanAgent(raw: unknown): ThirdPartyEndpoint | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const slug = typeof r.slug === "string" ? r.slug : null;
  const name = typeof r.name === "string" ? r.name : null;
  const description = typeof r.description === "string" ? r.description : "";
  if (!slug || !name) return null;
  return {
    provider: "san",
    name,
    ref: slug,
    description,
    apiUrl: `${SAN_GATEWAY}/api/v1/agents/${slug}/events`,
    x402Url: `${SAN_GATEWAY}/x402/v1/agents/${slug}/events`,
    networkId: "eip155:8453",
  };
}

/**
 * Cached fetch of every third-party x402 endpoint zBase can route. Always
 * resolves with at least the fallback list.
 */
export async function getThirdPartyEndpoints(): Promise<ThirdPartyEndpoint[]> {
  const now = Date.now();
  if (cache && cache.expires > now) return cache.endpoints;

  const endpoints = await fetchSanCatalog();
  cache = { expires: now + CACHE_TTL_MS, endpoints };
  return endpoints;
}

/**
 * Test seam — clears the in-memory cache. Not exported to the API surface;
 * use only in tests / dev tooling.
 */
export function _resetCatalogCache() {
  cache = null;
}
