import { getAddress, isAddress } from "viem";

export type X402ChainId = "eip155:8453" | "eip155:84532" | "solana:mainnet" | "solana:devnet";

export type X402ProviderCategory =
  | "ai-inference"
  | "data-api"
  | "agent-platform"
  | "enrichment"
  | "payments"
  | "market-data"
  | "security"
  | "unknown";

export type X402AttributionSource =
  | "402-challenge"
  | "x402scan"
  | "bazaar"
  | "manual"
  | "seed:x402scan"
  | "seed:zbase";

export interface X402PaymentRequirementRecord {
  chain: X402ChainId;
  asset?: `0x${string}`;
  payTo: `0x${string}`;
  amountAtomic?: string;
  endpoint?: string;
  resourceUrl?: string;
  source: X402AttributionSource;
  sourceUrl?: string;
  lastVerifiedAt?: string;
  confidence: "high" | "medium" | "low";
}

export interface X402ProviderRecord {
  id: string;
  name: string;
  domain: string;
  aliases: string[];
  category: X402ProviderCategory;
  chains: X402ChainId[];
  paymentAddresses: Partial<Record<X402ChainId, `0x${string}`[]>>;
  source: X402AttributionSource;
  confidence: "high" | "medium" | "low";
  tags: string[];
  paymentRequirements?: X402PaymentRequirementRecord[];
  x402scan?: {
    transactions?: number;
    buyers?: number;
    volumeUsd?: number;
  };
}

const normaliseAddresses = (addresses: string[]): `0x${string}`[] =>
  addresses
    .filter((address) => isAddress(address))
    .map((address) => getAddress(address) as `0x${string}`);

const NANSEN_AI_PAY_TO = "0x93053f1e7A5eFEDa532Fe69CbbE43cBEc3A0F13f" as const;
const ENABLE_MANUAL_PROVIDER_ATTRIBUTION = process.env.ZBASE_ENABLE_MANUAL_PROVIDER_ATTRIBUTION === "true";

/**
 * Initial provider map from the x402scan services we researched, plus the one
 * known payTo address already in the repo. Most x402scan entries expose domains
 * and chain coverage, not stable recipient addresses, so address matching stays
 * conservative until we ingest Bazaar/x402scan payment metadata directly.
 */
const SEED_PROVIDERS: X402ProviderRecord[] = [
  {
    id: "nansen-ai",
    name: "Nansen AI",
    domain: "api.nansen.ai",
    aliases: ["Nansen", "Nansen API"],
    category: "data-api",
    chains: ["eip155:8453"],
    paymentAddresses: {
      "eip155:8453": normaliseAddresses([NANSEN_AI_PAY_TO]),
    },
    paymentRequirements: [
      {
        chain: "eip155:8453",
        payTo: NANSEN_AI_PAY_TO,
        source: "manual",
        sourceUrl: "https://api.nansen.ai",
        confidence: "high",
      },
    ],
    source: "seed:zbase",
    confidence: "high",
    tags: ["wallet-intelligence", "market-data", "x402"],
    x402scan: { transactions: 6154, buyers: 93 },
  },
  {
    id: "onesource",
    name: "OneSource",
    domain: "api.onesource.io",
    aliases: ["OneSource API"],
    category: "data-api",
    chains: ["eip155:8453"],
    paymentAddresses: {},
    source: "seed:x402scan",
    confidence: "medium",
    tags: ["base", "data-api", "x402"],
    x402scan: { transactions: 10015, buyers: 1249 },
  },
  {
    id: "otto-ai",
    name: "Otto AI",
    domain: "x402.ottoai.services",
    aliases: ["Otto"],
    category: "agent-platform",
    chains: ["eip155:8453", "solana:mainnet"],
    paymentAddresses: {},
    source: "seed:x402scan",
    confidence: "medium",
    tags: ["agent", "base", "solana", "x402"],
    x402scan: { transactions: 31786, buyers: 561 },
  },
  {
    id: "stableenrich",
    name: "StableEnrich",
    domain: "stableenrich.dev",
    aliases: ["Stable Enrich"],
    category: "enrichment",
    chains: ["eip155:8453", "solana:mainnet"],
    paymentAddresses: {},
    source: "seed:x402scan",
    confidence: "medium",
    tags: ["enrichment", "base", "solana", "x402"],
    x402scan: { transactions: 50400, buyers: 516 },
  },
  {
    id: "x402stock",
    name: "x402stock",
    domain: "x402stock.xyz",
    aliases: ["x402 Stock"],
    category: "market-data",
    chains: ["eip155:8453"],
    paymentAddresses: {},
    source: "seed:x402scan",
    confidence: "medium",
    tags: ["market-data", "base", "x402"],
    x402scan: { transactions: 3357, buyers: 125 },
  },
  {
    id: "agentutility",
    name: "agentutility",
    domain: "x402.agentutility.ai",
    aliases: ["Agent Utility"],
    category: "agent-platform",
    chains: ["eip155:8453"],
    paymentAddresses: {},
    source: "seed:x402scan",
    confidence: "medium",
    tags: ["agent", "base", "x402"],
    x402scan: { transactions: 21937, buyers: 205 },
  },
  {
    id: "apify-agi",
    name: "Apify AGI",
    domain: "agi.apify.com",
    aliases: ["Apify"],
    category: "data-api",
    chains: ["eip155:8453"],
    paymentAddresses: {},
    source: "seed:x402scan",
    confidence: "medium",
    tags: ["web-data", "automation", "base", "x402"],
    x402scan: { transactions: 527, buyers: 193 },
  },
  {
    id: "blockrun",
    name: "BlockRun",
    domain: "blockrun.ai",
    aliases: ["ClawRouter", "Franklin Agent"],
    category: "agent-platform",
    chains: ["eip155:8453", "solana:mainnet"],
    paymentAddresses: {},
    source: "seed:x402scan",
    confidence: "medium",
    tags: ["model-router", "agent", "base", "solana", "x402"],
  },
];

export function getX402ProviderCatalog(): X402ProviderRecord[] {
  return SEED_PROVIDERS;
}

export function findX402ProviderByAddress(
  address: string,
  network: X402ChainId = "eip155:8453",
): X402ProviderRecord | null {
  return findX402ProviderAttributionByAddress(address, network)?.provider ?? null;
}

export function findX402ProviderAttributionByAddress(
  address: string,
  network: X402ChainId = "eip155:8453",
): { provider: X402ProviderRecord; requirement?: X402PaymentRequirementRecord; verified: boolean } | null {
  if (!isAddress(address)) return null;
  const lower = getAddress(address).toLowerCase();
  for (const provider of SEED_PROVIDERS) {
    const requirement = provider.paymentRequirements?.find(
      (candidate) => candidate.chain === network && candidate.payTo.toLowerCase() === lower,
    );
    const usableRequirement = provider.paymentRequirements?.find(
      (candidate) =>
        candidate.chain === network &&
        candidate.payTo.toLowerCase() === lower &&
        (candidate.source !== "manual" || ENABLE_MANUAL_PROVIDER_ATTRIBUTION),
    );
    if (usableRequirement) {
      return { provider, requirement: usableRequirement, verified: usableRequirement.source === "402-challenge" };
    }
    if (requirement) continue;
    if ((provider.paymentAddresses[network] ?? []).some((candidate) => candidate.toLowerCase() === lower)) {
      if (provider.source === "manual" && !ENABLE_MANUAL_PROVIDER_ATTRIBUTION) continue;
      return { provider, verified: false };
    }
  }
  return null;
}

export function providerDisplayName(provider: X402ProviderRecord | null, fallbackAddress: string): string {
  return provider?.name ?? `Possible x402-like payment (${fallbackAddress.slice(0, 6)}...${fallbackAddress.slice(-4)})`;
}
