/**
 * sellerClient.ts — the SELLER half of the private x402 marketplace.
 *
 * An API provider gates their endpoint with x402 and receives funds IMMEDIATELY
 * to their EXISTING wallet (the standard `payTo` flow): the facilitator settles
 * the buyer's gasless EIP-3009 authorization on-chain in ~1-2s and sponsors gas.
 * No meta-address, no stealth, no pool on the receive path — the seller uses the
 * wallet they already have. Buyer privacy is unaffected: the payer is a fresh
 * pool-funded EOA regardless of how the seller receives.
 *
 * This module is the PURE, dependency-light core (no @x402 / next imports):
 *   createSeller(config)                 → a normalized seller handle
 *   buildPaymentRequired(seller, {url})  → the spec x402 402 body to return
 *
 * The Next route wrapper that verifies + settles the buyer's X-PAYMENT lives in
 * the app at src/lib/private-x402-seller.ts (it needs @x402/core + a facilitator).
 * The 402 this produces is exactly what the buyer SDK's selectExactAccepts /
 * settlePrivatelyX402 consumes — extra.{name,version} is the USDC EIP-712 domain
 * the buyer signs against, so it MUST be correct per network.
 */
import type { FacilitatorNetwork } from "./facilitatorClient.js";

/**
 * Default facilitator a seller settles through: the zBase spec facilitator base
 * (the @x402/core HTTPFacilitatorClient appends `/verify` + `/settle`). Routing
 * through zBase is what lets zBase take its per-settle fee. Override with
 * `facilitatorUrl` to settle via CDP/another facilitator instead.
 */
export const DEFAULT_SELLER_FACILITATOR_URL = "https://zbase.app/api/facilitator/x402";

/** USDC deployment + its EIP-712 domain per supported network. */
interface UsdcInfo {
  asset: string;
  /** EIP-712 domain `name` — what the buyer signs transferWithAuthorization against. */
  name: string;
  /** EIP-712 domain `version`. */
  version: string;
}

// Verified USDC deployments. The EIP-712 domain differs by deployment (mainnet
// Circle USDC is "USD Coin", the Base Sepolia test USDC is "USDC") — a wrong
// domain makes the buyer's signature unrecoverable, so keep this exact.
const USDC_BY_NETWORK: Record<FacilitatorNetwork, UsdcInfo> = {
  "eip155:8453": {
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    name: "USD Coin",
    version: "2",
  },
  "eip155:84532": {
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    name: "USDC",
    version: "2",
  },
};

export interface SellerConfig {
  /** The seller's EXISTING wallet — funds land here immediately. */
  payTo: string;
  /** Price per call, atomic USDC (6 decimals). e.g. "10000" = $0.01. */
  priceAtomic: string | bigint;
  /** Network the seller settles on. Defaults to Base Sepolia. */
  network?: FacilitatorNetwork;
  /** Override the USDC asset address (defaults to the network's canonical USDC). */
  asset?: string;
  /** Override the EIP-712 domain (only if using a non-standard token). */
  tokenName?: string;
  tokenVersion?: string;
  /** Human description of the resource being sold. */
  description?: string;
  /** Authorization validity window handed to the buyer. Default 300s. */
  maxTimeoutSeconds?: number;
  /**
   * Facilitator that verifies + settles. Omit for the zBase default; pass an
   * alternative URL to use another facilitator, or `""` for the route helper's
   * Coinbase CDP fallback. This is consumed by the Next route helper, not here.
   */
  facilitatorUrl?: string;
}

export interface Seller {
  payTo: string;
  priceAtomic: string;
  network: FacilitatorNetwork;
  asset: string;
  tokenName: string;
  tokenVersion: string;
  description: string;
  maxTimeoutSeconds: number;
  facilitatorUrl?: string;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Normalize + validate a seller's config. No key generation, no network calls —
 * the seller supplies the wallet they already have.
 */
export function createSeller(config: SellerConfig): Seller {
  const network = config.network ?? "eip155:8453";
  const usdc = USDC_BY_NETWORK[network];
  if (!usdc) {
    throw new Error(`Unsupported network ${network} — use eip155:8453 or eip155:84532.`);
  }
  if (!ADDRESS_RE.test(config.payTo)) {
    throw new Error(`payTo must be a 0x EVM address, got: ${config.payTo}`);
  }
  const asset = config.asset ?? usdc.asset;
  if (!ADDRESS_RE.test(asset)) {
    throw new Error(`asset must be a 0x EVM address, got: ${asset}`);
  }
  const priceAtomic = config.priceAtomic.toString();
  if (!/^[1-9][0-9]*$/.test(priceAtomic)) {
    throw new Error(`priceAtomic must be a positive integer string (atomic USDC), got: ${priceAtomic}`);
  }
  const maxTimeoutSeconds = config.maxTimeoutSeconds ?? 300;
  if (!Number.isSafeInteger(maxTimeoutSeconds) || maxTimeoutSeconds <= 0) {
    throw new Error(`maxTimeoutSeconds must be a positive integer, got: ${maxTimeoutSeconds}`);
  }
  return {
    payTo: config.payTo,
    priceAtomic,
    network,
    asset,
    // Custom domain only if BOTH overrides are provided; else the network's USDC domain.
    tokenName: config.tokenName ?? usdc.name,
    tokenVersion: config.tokenVersion ?? usdc.version,
    description: config.description ?? "x402 paid resource",
    maxTimeoutSeconds,
    // Default to zBase's facilitator so sellers route the per-settle take to zBase.
    // Pass facilitatorUrl (or "" for CDP) to override.
    facilitatorUrl: config.facilitatorUrl ?? DEFAULT_SELLER_FACILITATOR_URL,
  };
}

/** One `exact`-scheme entry — matches @x402/core PaymentRequirements + the buyer's X402AcceptsEntry. */
export interface SellerAccepts {
  scheme: "exact";
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string };
}

/** The spec x402 402 body. Matches the buyer SDK's X402PaymentRequired. */
export interface SellerPaymentRequired {
  x402Version: number;
  error?: string;
  resource: { url: string; description: string; mimeType: string };
  accepts: SellerAccepts[];
  /** Optional discovery/other x402 extensions (e.g. the bazaar discovery extension). */
  extensions?: Record<string, unknown>;
}

/**
 * Build the 402 body to return when a request arrives without a valid payment.
 * `payTo` is the seller's existing wallet; `extra.{name,version}` is the USDC
 * EIP-712 domain the buyer signs against. Pass `extensions` (e.g. from the bazaar
 * discovery helper) to have the resource indexed in the x402 bazaar.
 */
export function buildPaymentRequired(
  seller: Seller,
  opts: { resourceUrl: string; error?: string; mimeType?: string; extensions?: Record<string, unknown> },
): SellerPaymentRequired {
  return {
    x402Version: 2,
    ...(opts.error ? { error: opts.error } : {}),
    resource: {
      url: opts.resourceUrl,
      description: seller.description,
      mimeType: opts.mimeType ?? "application/json",
    },
    accepts: [
      {
        scheme: "exact",
        network: seller.network,
        amount: seller.priceAtomic,
        asset: seller.asset,
        payTo: seller.payTo,
        maxTimeoutSeconds: seller.maxTimeoutSeconds,
        extra: { name: seller.tokenName, version: seller.tokenVersion },
      },
    ],
    ...(opts.extensions ? { extensions: opts.extensions } : {}),
  };
}
