/**
 * usdc-domain.ts — the EIP-712 domain (name/version) for Circle USDC's
 * EIP-3009 `transferWithAuthorization` / `receiveWithAuthorization`, per
 * chain. Chains disagree on `name()` (mainnet USDC is "USD Coin"; several
 * testnet USDC deployments are literally "USDC"), and a wrong domain means
 * every signature recovers to the wrong address — silently, not with an
 * error — so this is centralized rather than re-typed at each call site.
 *
 * Base (8453) / Base Sepolia (84532): kept EXACTLY as
 * `forwarding-sweep.ts` `sweepDomain()` has always used — do NOT "fix" these
 * even though a live on-chain check today (`cast call 0x036CbD53...
 * 'name()(string)' --rpc-url https://sepolia.base.org`) returned `"USDC"`,
 * not `"USD Coin"`. Changing this literal would invalidate every live
 * EIP-712 signature flow on Base Sepolia overnight; that's a deliberate
 * follow-up, not tonight's change (flagged in the hackathon report).
 *
 * Ethereum mainnet (1): "USD Coin" / "2" — Circle's canonical mainnet USDC.
 *
 * Ethereum Sepolia (11155111): "USDC" / "2" — verified on-chain 2026-09-13
 * against 0xbow's Ethereum Sepolia pool's USDC (`name()` = "USDC", `version()`
 * = "2"). Circle's testnet USDC intentionally ships a different `name()` than
 * mainnet; this is not a typo.
 */
export function usdcDomainFor(chainId: number): { name: string; version: string } {
  switch (chainId) {
    case 8453: // Base — literal unchanged, see file header
    case 84532: // Base Sepolia — literal unchanged, see file header
      return { name: "USD Coin", version: "2" };
    case 1: // Ethereum mainnet
      return { name: "USD Coin", version: "2" };
    case 11155111: // Ethereum Sepolia
      return { name: "USDC", version: "2" };
    default:
      throw new Error(`usdcDomainFor: no known USDC EIP-712 domain for chainId ${chainId}`);
  }
}
