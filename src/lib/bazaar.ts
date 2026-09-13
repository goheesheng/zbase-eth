/**
 * bazaar.ts — get a seller's x402 API LISTED in the public x402 bazaar so buyers
 * can discover it. Sellers are indexed by declaring the discovery extension in
 * their 402 response (the facilitator/crawler picks it up); there is no separate
 * registration POST. Pair with the buyer-side `FacilitatorClient.discover()`.
 *
 * See CLAUDE.md: `declareDiscoveryExtension` from `@x402/extensions/bazaar` is
 * required for bazaar visibility.
 */
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";

/** The config `declareDiscoveryExtension` accepts (method/input/inputSchema/output/…). */
export type SellerDiscoveryConfig = Parameters<typeof declareDiscoveryExtension>[0];

/**
 * Build the discovery `extensions` object to merge into a seller's 402 body
 * (`buildPaymentRequired({ extensions })` or `withPrivateX402(..., { discovery })`).
 * Delegates the schema to `@x402/extensions/bazaar`. Returns `{}` on any error —
 * being un-indexed must never break selling.
 *
 * @example
 *   const discovery = sellerDiscoveryExtension({
 *     input: { chain: "solana", token_address: "..." },
 *     inputSchema: { properties: { chain: { type: "string" } }, required: ["chain"] },
 *     bodyType: "json",
 *     output: { example: { topTraded: ["TSLAx"] } },
 *   });
 */
export function sellerDiscoveryExtension(config: SellerDiscoveryConfig): Record<string, unknown> {
  try {
    return declareDiscoveryExtension(config);
  } catch {
    return {};
  }
}
