/**
 * hypersync.ts — HyperSync JSON-RPC endpoint selection, shared by every
 * caller that today hardcodes a `*.rpc.hypersync.xyz` URL keyed off
 * `activeChain.network === "mainnet"`.
 *
 * ENTITLEMENT FACT (verified 2026-09-13, do not re-derive): our HYPERSYNC_TOKEN
 * is entitled to Base + Base Sepolia ONLY. Hitting `sepolia.rpc.hypersync.xyz`
 * or `eth.rpc.hypersync.xyz` with this token returns "Your token does not have
 * access to this product". So on Ethereum (mainnet or Sepolia) every caller
 * MUST take the chunked eth_getLogs RPC-fallback path — this function returns
 * null there by default, which is the signal callers branch on.
 *
 * `HYPERSYNC_CHAINS` (comma-separated chain ids, default "8453,84532" — Base +
 * Base Sepolia, matching the token's actual entitlement) lets ops widen this
 * without a code change if the token is ever upgraded. `HYPERSYNC_URL` is a
 * raw override that wins for ANY chain (local/dev pointing at a proxy, etc).
 */

const DEFAULT_HYPERSYNC_CHAINS = "8453,84532";

const HYPERSYNC_ENDPOINTS: Record<number, string> = {
  8453: "https://base.rpc.hypersync.xyz", // Base mainnet
  84532: "https://base-sepolia.rpc.hypersync.xyz", // Base Sepolia
  1: "https://eth.rpc.hypersync.xyz", // Ethereum mainnet — NOT entitled on our token today
  11155111: "https://sepolia.rpc.hypersync.xyz", // Ethereum Sepolia — NOT entitled on our token today
};

function entitledChainIds(): number[] {
  return (process.env.HYPERSYNC_CHAINS ?? DEFAULT_HYPERSYNC_CHAINS)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isFinite(n));
}

/**
 * HyperSync JSON-RPC endpoint for a chain, or null when the RPC-fallback path
 * must be used (no HYPERSYNC_TOKEN set, chain not in HYPERSYNC_CHAINS, or the
 * chain has no known HyperSync endpoint at all).
 */
export function hypersyncUrlFor(chainId: number): string | null {
  if (process.env.HYPERSYNC_URL) return process.env.HYPERSYNC_URL;
  if (!process.env.HYPERSYNC_TOKEN) return null;
  if (!entitledChainIds().includes(chainId)) return null;
  return HYPERSYNC_ENDPOINTS[chainId] ?? null;
}

/** The bearer token for HyperSync requests, if configured. */
export function hypersyncToken(): string | undefined {
  return process.env.HYPERSYNC_TOKEN || undefined;
}
