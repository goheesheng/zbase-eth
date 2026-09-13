import { createPublicClient, getAddress, http, isAddress, parseAbi } from "viem";
import { base } from "viem/chains";
import {
  findX402ProviderAttributionByAddress,
  getX402ProviderCatalog,
  providerDisplayName,
  type X402AttributionSource,
  type X402ProviderCategory,
  type X402ProviderRecord,
} from "@/lib/x402-provider-catalog";
import {
  catalogEvidence,
  onchainHeuristicEvidence,
  resolveExternalX402Attributions,
  type ExternalAttributionOptions,
  type X402ConfidenceEvidence,
  type X402ReportAttributionSource,
} from "@/lib/x402-attribution-sources";
import { staticFallbackProvider, type ReasonCode, type SanctionsProvider } from "@/lib/ofac-screening";
import { hypersyncUrlFor, hypersyncToken } from "@/lib/hypersync";

export const BASE_USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

const USDC_TRANSFER_EVENT = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

// This module is Base-mainnet-only by design (chain: base below, BASE_USDC_ADDRESS
// above). chainId 8453 is always HyperSync-entitled today, so this is
// `hypersyncUrlFor(8453) ?? <today's literal>` — kept as an explicit fallback so
// behaviour is unchanged even if HYPERSYNC_CHAINS were ever narrowed.
const HYPERSYNC_URL = hypersyncUrlFor(8453) ?? "https://base.rpc.hypersync.xyz";
const hasHyperSyncToken = Boolean(hypersyncUrlFor(8453));
const DEFAULT_LOOKBACK_BLOCKS = BigInt(
  process.env.ZBASE_EXPOSURE_LOOKBACK_BLOCKS ?? (hasHyperSyncToken ? "25000000" : "50000"),
);
const LOG_CHUNK_SIZE = 9999n;

const publicClient = createPublicClient({
  chain: base,
  transport: http(process.env.BASE_MAINNET_RPC ?? "https://mainnet.base.org"),
});

const hyperSyncLogClient = hasHyperSyncToken
  ? createPublicClient({
      chain: base,
      transport: http(HYPERSYNC_URL, {
        fetchOptions: { headers: { Authorization: `Bearer ${hypersyncToken()}` } },
      }),
    })
  : null;

const KNOWN_BASE_COUNTERPARTIES: Record<
  string,
  { label: string; kind: "dex-router" | "aggregator" | "bridge" | "lending" | "wallet" }
> = {
  "0x2626664c2603336e57b271c5c0b26f421741e481": { label: "Uniswap V3 SwapRouter02", kind: "dex-router" },
  "0x6ff5693b99212da76ad316178a184ab56d299b43": { label: "Uniswap Universal Router", kind: "dex-router" },
  "0xcfd50560cfe7cb75c90a2b9d388bdefc53d02563": { label: "Aerodrome Router", kind: "dex-router" },
  "0x111111125421ca6dc452d289314280a0f8842a65": { label: "1inch Aggregation Router", kind: "aggregator" },
  "0x4200000000000000000000000000000000000010": { label: "Base Standard Bridge", kind: "bridge" },
};

export type TransferClassification =
  | "verified-x402"
  | "attributed-x402"
  | "possible-x402"
  | "non-x402-defi"
  | "unknown-transfer";

export interface Transfer {
  to: `0x${string}`;
  amount: number;
  amountAtomic: string;
  blockNumber: number;
  txHash: `0x${string}`;
  provider?: string;
  providerId?: string;
  category?: X402ProviderCategory;
  confidence: "high" | "medium" | "low";
  classification: TransferClassification;
  reason: string;
  attributionSource?: X402AttributionSource;
  attributionSourceUrl?: string;
  providerDomain?: string;
  whyThisWasClassified?: string;
  whatWeCannotProve?: string;
  attributionEvidence?: X402ConfidenceEvidence[];
  counterpartyLabel?: string;
  counterpartyKind?: string;
}

export interface WalletAnalysis {
  address: `0x${string}`;
  totalTransfers: number;
  x402PaymentsDetected: number;
  totalSpendVisible: string;
  riskScore: number;
  riskLevel: "HIGH" | "MEDIUM" | "LOW";
  providerCounts: Record<string, { payments: number; totalUSDC: number; confidence: "high" | "medium" | "low" }>;
  x402Payments: Transfer[];
  verifiedX402Payments: Transfer[];
  attributedX402Payments: Transfer[];
  possibleX402Payments: Transfer[];
  nonX402DeFiActivity: Transfer[];
  servicesExposed: string[];
  transfers: Transfer[];
  scannedBlocks: {
    from: number;
    to: number;
    lookback: number;
  };
  generatedAt: string;
}

export interface ExposureEvidence {
  type: "verified-x402-payment" | "attributed-x402-payment" | "possible-x402-payment" | "counterparty-risk" | "defi-activity";
  txHash: `0x${string}`;
  chain: "base";
  blockNumber: number;
  counterparty: `0x${string}`;
  label: string;
  amountUSDC: string;
  confidence: "high" | "medium" | "low";
  explanation: string;
  classification?: TransferClassification;
  providerDomain?: string;
  source?: X402ReportAttributionSource;
  matchedPayTo?: `0x${string}`;
  matchedAmount?: string;
  resourceUrl?: string;
  sourceUrl?: string;
  lastVerifiedAt?: string;
  attributionSource?: X402AttributionSource;
  whyThisWasClassified?: string;
  whatWeCannotProve?: string;
  confidenceEvidence?: X402ConfidenceEvidence[];
}

export interface ProviderHistoryItem {
  provider: string;
  providerId?: string;
  domain?: string;
  category: X402ProviderCategory;
  payments: number;
  totalUSDC: string;
  firstBlock: number;
  lastBlock: number;
  confidence: "high" | "medium" | "low";
  classification: Extract<TransferClassification, "verified-x402" | "attributed-x402" | "possible-x402">;
  attributionSource?: X402AttributionSource;
  confidenceEvidence: X402ConfidenceEvidence[];
  evidence: ExposureEvidence[];
  interpretation: string;
}

export interface ExposureReport {
  schemaVersion: 1;
  address: `0x${string}`;
  generatedAt: string;
  network: "base";
  summary: {
    headline: string;
    riskScore: number;
    riskLevel: WalletAnalysis["riskLevel"];
    confidence: "high" | "medium" | "low";
    reportMode: "full" | "redacted";
  };
  walletExposure: {
    totalTransfersScanned: number;
    x402PaymentsDetected: number;
    verifiedX402Payments: number;
    attributedX402Payments: number;
    possibleX402Payments: number;
    totalX402SpendUSDC: string;
    uniqueProviders: number;
    scannedBlocks: WalletAnalysis["scannedBlocks"];
  };
  verifiedX402Payments: ExposureEvidence[];
  attributedX402Payments: ExposureEvidence[];
  possibleX402Payments: ExposureEvidence[];
  nonX402DeFiActivity: ExposureEvidence[];
  x402ProviderHistory: ProviderHistoryItem[];
  tradeAndDeFiBehavior: {
    likelyActivities: string[];
    confidence: "high" | "medium" | "low";
    evidence: ExposureEvidence[];
    explanation: string;
  };
  riskExposure: {
    directMatches: Array<{
      address: `0x${string}`;
      reason: ReasonCode;
      label: string;
      severity: "blocked-direct";
    }>;
    proximityWarnings: Array<{
      address: `0x${string}`;
      label: string;
      severity: "review";
      explanation: string;
    }>;
    disclaimer: string;
  };
  likelyNextActions: string[];
  recommendations: string[];
  evidence: ExposureEvidence[];
  attributionChecks: X402ConfidenceEvidence[];
  providerCatalog: Array<
    Pick<
      X402ProviderRecord,
      "id" | "name" | "domain" | "category" | "chains" | "confidence" | "source" | "paymentRequirements"
    >
  >;
}

export interface AnalyzeWalletOptions {
  transfers?: Transfer[];
  latestBlock?: bigint;
  lookbackBlocks?: bigint;
  screeningProvider?: SanctionsProvider;
  enableExternalAttribution?: boolean;
  externalAttribution?: ExternalAttributionOptions;
}

function confidenceRank(value: "high" | "medium" | "low"): number {
  return value === "high" ? 3 : value === "medium" ? 2 : 1;
}

function minConfidence(values: Array<"high" | "medium" | "low">): "high" | "medium" | "low" {
  const min = Math.min(...values.map(confidenceRank));
  return min >= 3 ? "high" : min >= 2 ? "medium" : "low";
}

function isX402Classification(classification: TransferClassification): boolean {
  return (
    classification === "verified-x402" ||
    classification === "attributed-x402" ||
    classification === "possible-x402"
  );
}

async function fetchOutgoingUsdcTransfers(address: `0x${string}`, latestBlock?: bigint, lookbackBlocks = DEFAULT_LOOKBACK_BLOCKS) {
  const latest = latestBlock ?? (await publicClient.getBlockNumber());
  const fromBlock = latest > lookbackBlocks ? latest - lookbackBlocks : 0n;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allLogs: any[] = [];

  if (hyperSyncLogClient) {
    allLogs.push(
      ...(await hyperSyncLogClient.getLogs({
        address: BASE_USDC_ADDRESS,
        event: USDC_TRANSFER_EVENT[0],
        args: { from: address },
        fromBlock,
        toBlock: latest,
      })),
    );
  } else {
    for (let from = fromBlock; from <= latest; from += LOG_CHUNK_SIZE + 1n) {
      const to = from + LOG_CHUNK_SIZE > latest ? latest : from + LOG_CHUNK_SIZE;
      const chunk = await publicClient.getLogs({
        address: BASE_USDC_ADDRESS,
        event: USDC_TRANSFER_EVENT[0],
        args: { from: address },
        fromBlock: from,
        toBlock: to,
      });
      allLogs.push(...chunk);
    }
  }

  const transfers: Transfer[] = allLogs.map((log) => ({
    to: getAddress((log.args.to ?? "0x0000000000000000000000000000000000000000") as string) as `0x${string}`,
    amount: Number(log.args.value ?? 0n) / 1e6,
    amountAtomic: String(log.args.value ?? 0n),
    blockNumber: Number(log.blockNumber),
    txHash: log.transactionHash as `0x${string}`,
    confidence: "low",
    classification: "unknown-transfer",
    reason: "Raw outgoing Base USDC transfer",
  }));

  return {
    transfers,
    scannedBlocks: {
      from: Number(fromBlock),
      to: Number(latest),
      lookback: Number(latest - fromBlock),
    },
  };
}

function classifyTransfer(transfer: Transfer): Transfer {
  const attribution = findX402ProviderAttributionByAddress(transfer.to);
  if (attribution) {
    const { provider, requirement, verified } = attribution;
    const classification = verified ? "verified-x402" : "attributed-x402";
    const evidenceSource =
      verified ? "live-402" : requirement?.source === "bazaar" ? "bazaar" : requirement?.source === "x402scan" ? "x402scan" : "manual-catalog";
    return {
      ...transfer,
      provider: providerDisplayName(provider, transfer.to),
      providerId: provider.id,
      category: provider.category,
      providerDomain: provider.domain,
      attributionSource: requirement?.source ?? provider.source,
      attributionSourceUrl: requirement?.sourceUrl,
      confidence: verified ? "high" : provider.confidence,
      classification,
      reason: verified
        ? "Recipient address matches a payTo extracted from a live x402 402 challenge"
        : "Recipient address matches an attributed x402 provider catalog entry",
      attributionEvidence: [
        catalogEvidence({
          source: evidenceSource,
          payTo: transfer.to,
          amountAtomic: requirement?.amountAtomic,
          resourceUrl: requirement?.resourceUrl ?? requirement?.endpoint,
          provider: providerDisplayName(provider, transfer.to),
          providerDomain: provider.domain,
          category: provider.category,
          lastVerifiedAt: requirement?.lastVerifiedAt,
          whatWeCannotProve: verified
            ? undefined
            : "The catalog links this payTo to a provider, but it does not prove the exact HTTP request made by the wallet.",
        }),
      ],
      whyThisWasClassified: verified
        ? "The provider's x402 payment requirements name this payTo address on Base."
        : "The payTo address is present in the provider catalog, but it was not verified from a live 402 challenge in this report run.",
      whatWeCannotProve: verified
        ? undefined
        : "This report does not prove the specific HTTP endpoint called by the wallet.",
    };
  }

  const counterparty = KNOWN_BASE_COUNTERPARTIES[transfer.to.toLowerCase()];
  if (counterparty) {
    return {
      ...transfer,
      counterpartyLabel: counterparty.label,
      counterpartyKind: counterparty.kind,
      confidence: "high",
      classification: "non-x402-defi",
      reason: `Recipient is a known Base ${counterparty.kind}`,
      whyThisWasClassified: "The recipient is a known Base router or infrastructure contract, so it is separated from x402 provider usage.",
    };
  }

  if (transfer.amount >= 0.001 && transfer.amount <= 1.0) {
    return {
      ...transfer,
      provider: providerDisplayName(null, transfer.to),
      category: "unknown",
      confidence: "low",
      classification: "possible-x402",
      reason: "Small USDC payment in common x402 price range; recipient is not yet in catalog",
      attributionEvidence: [
        onchainHeuristicEvidence({
          payTo: transfer.to,
          amountAtomic: transfer.amountAtomic,
          amountUSDC: transfer.amount.toFixed(6),
        }),
      ],
      whyThisWasClassified: "The transfer amount fits common x402 pricing and the recipient is not a known DeFi/router counterparty.",
      whatWeCannotProve: "No provider domain, live 402 challenge, Bazaar entry, or x402scan payTo attribution has been linked to this recipient.",
    };
  }

  return transfer;
}

async function enrichTransfersWithExternalAttribution(
  transfers: Transfer[],
  options: AnalyzeWalletOptions,
): Promise<Transfer[]> {
  if (!options.enableExternalAttribution && !options.externalAttribution?.preloaded?.length) return transfers;
  const candidates = transfers.filter((transfer) => transfer.classification !== "non-x402-defi");
  const resolved = await resolveExternalX402Attributions(
    candidates.map((transfer) => transfer.to),
    {
      ...(options.externalAttribution ?? {}),
      enabled: options.enableExternalAttribution,
    },
  );
  if (resolved.size === 0) return transfers;

  return transfers.map((transfer) => {
    const attribution = resolved.get(transfer.to.toLowerCase());
    if (!attribution) return transfer;
    const confidenceEvidence = [...(transfer.attributionEvidence ?? []), ...attribution.evidence];
    if (!attribution.classification || !attribution.provider) {
      return {
        ...transfer,
        attributionEvidence: confidenceEvidence,
        whatWeCannotProve: transfer.whatWeCannotProve ?? attribution.evidence.at(-1)?.whatWeCannotProve,
      };
    }

    const verified = attribution.classification === "verified-x402";
    return {
      ...transfer,
      provider: attribution.provider,
      category: attribution.category ?? transfer.category ?? "unknown",
      providerDomain: attribution.providerDomain ?? transfer.providerDomain,
      confidence: attribution.confidence ?? (verified ? "high" : "medium"),
      classification: attribution.classification,
      reason: verified
        ? "Recipient payTo was verified from a live x402 402 challenge"
        : "Recipient payTo was attributed through an external x402 discovery source",
      attributionEvidence: confidenceEvidence,
      whyThisWasClassified: verified
        ? "A live unpaid request returned x402 payment requirements naming this payTo address."
        : "Bazaar or x402scan maps this payTo address to a provider/resource.",
      whatWeCannotProve: verified
        ? undefined
        : "This attribution links the payTo to a provider/resource, but it does not prove the exact HTTP request made by the wallet.",
    };
  });
}

function buildProviderCounts(x402Payments: Transfer[]): WalletAnalysis["providerCounts"] {
  const providerCounts: WalletAnalysis["providerCounts"] = {};
  for (const payment of x402Payments) {
    const key = payment.provider ?? payment.to;
    const existing = providerCounts[key] ?? { payments: 0, totalUSDC: 0, confidence: payment.confidence };
    existing.payments += 1;
    existing.totalUSDC += payment.amount;
    existing.confidence = minConfidence([existing.confidence, payment.confidence]);
    providerCounts[key] = existing;
  }
  return providerCounts;
}

function scoreRisk(transfers: Transfer[], x402Payments: Transfer[], providerCounts: WalletAnalysis["providerCounts"]): number {
  const verifiedPayments = x402Payments.filter((payment) => payment.classification === "verified-x402").length;
  const attributedPayments = x402Payments.filter((payment) => payment.classification === "attributed-x402").length;
  const possiblePayments = x402Payments.filter((payment) => payment.classification === "possible-x402").length;
  const totalSpend = x402Payments.reduce((sum, payment) => sum + payment.amount, 0);
  let riskScore = 0;
  riskScore += Math.min(verifiedPayments * 7, 35);
  riskScore += Math.min(attributedPayments * 8, 35);
  riskScore += Math.min(possiblePayments * 2, 20);
  riskScore += Math.min(Object.keys(providerCounts).length * 10, 30);
  riskScore += totalSpend > 50 ? 30 : totalSpend > 10 ? 20 : totalSpend > 1 ? 8 : 0;
  riskScore += transfers.length > 50 ? 5 : 0;
  return Math.min(riskScore, 100);
}

export async function analyzeWallet(address: string, options: AnalyzeWalletOptions = {}): Promise<WalletAnalysis> {
  if (!isAddress(address)) throw new Error("Invalid Ethereum address");
  const checksumAddress = getAddress(address) as `0x${string}`;
  const fetched = options.transfers
    ? {
        transfers: options.transfers,
        scannedBlocks: {
          from: Math.min(...options.transfers.map((transfer) => transfer.blockNumber), 0),
          to: Math.max(...options.transfers.map((transfer) => transfer.blockNumber), 0),
          lookback: Number(options.lookbackBlocks ?? DEFAULT_LOOKBACK_BLOCKS),
        },
      }
    : await fetchOutgoingUsdcTransfers(checksumAddress, options.latestBlock, options.lookbackBlocks);

  const transfers = (await enrichTransfersWithExternalAttribution(
    fetched.transfers.map(classifyTransfer),
    options,
  )).sort((a, b) => a.blockNumber - b.blockNumber);
  const x402Payments = transfers.filter((transfer) => isX402Classification(transfer.classification));
  const verifiedX402Payments = x402Payments.filter((transfer) => transfer.classification === "verified-x402");
  const attributedX402Payments = x402Payments.filter((transfer) => transfer.classification === "attributed-x402");
  const possibleX402Payments = x402Payments.filter((transfer) => transfer.classification === "possible-x402");
  const nonX402DeFiActivity = transfers.filter((transfer) => transfer.classification === "non-x402-defi");
  const providerCounts = buildProviderCounts(x402Payments);
  const totalSpend = x402Payments.reduce((sum, payment) => sum + payment.amount, 0);
  const riskScore = scoreRisk(transfers, x402Payments, providerCounts);
  const riskLevel: WalletAnalysis["riskLevel"] =
    riskScore >= 70 ? "HIGH" : riskScore >= 40 ? "MEDIUM" : "LOW";

  return {
    address: checksumAddress,
    totalTransfers: transfers.length,
    x402PaymentsDetected: x402Payments.length,
    totalSpendVisible: totalSpend.toFixed(2),
    riskScore,
    riskLevel,
    providerCounts,
    x402Payments,
    verifiedX402Payments,
    attributedX402Payments,
    possibleX402Payments,
    nonX402DeFiActivity,
    servicesExposed: [
      ...new Set(
        x402Payments
          .filter((payment) => payment.classification !== "possible-x402")
          .map((payment) => payment.provider)
          .filter((provider): provider is string => Boolean(provider)),
      ),
    ],
    transfers,
    scannedBlocks: fetched.scannedBlocks,
    generatedAt: new Date().toISOString(),
  };
}

function evidenceTypeForClassification(classification: TransferClassification): ExposureEvidence["type"] {
  if (classification === "verified-x402") return "verified-x402-payment";
  if (classification === "attributed-x402") return "attributed-x402-payment";
  if (classification === "possible-x402") return "possible-x402-payment";
  if (classification === "non-x402-defi") return "defi-activity";
  return "counterparty-risk";
}

function evidenceFromTransfer(payment: Transfer): ExposureEvidence {
  const bestEvidence =
    payment.attributionEvidence?.find((evidence) => evidence.status === "matched" && evidence.source === "live-402") ??
    payment.attributionEvidence?.find((evidence) => evidence.status === "matched" && evidence.source !== "onchain-heuristic") ??
    payment.attributionEvidence?.find((evidence) => evidence.status === "matched") ??
    payment.attributionEvidence?.[0];
  return {
    type: evidenceTypeForClassification(payment.classification),
    txHash: payment.txHash,
    chain: "base",
    blockNumber: payment.blockNumber,
    counterparty: payment.to,
    label: payment.provider ?? payment.counterpartyLabel ?? "Unknown counterparty",
    amountUSDC: payment.amount.toFixed(6),
    confidence: payment.confidence,
    explanation: payment.reason,
    classification: payment.classification,
    providerDomain: payment.providerDomain,
    source: bestEvidence?.source,
    matchedPayTo: bestEvidence?.matchedPayTo,
    matchedAmount: bestEvidence?.matchedAmount,
    resourceUrl: bestEvidence?.resourceUrl,
    sourceUrl: bestEvidence?.sourceUrl,
    lastVerifiedAt: bestEvidence?.lastVerifiedAt,
    attributionSource: payment.attributionSource,
    whyThisWasClassified: payment.whyThisWasClassified,
    whatWeCannotProve: payment.whatWeCannotProve,
    confidenceEvidence: payment.attributionEvidence,
  };
}

function providerHistoryClassification(
  payments: Transfer[],
): Extract<TransferClassification, "verified-x402" | "attributed-x402" | "possible-x402"> {
  if (payments.some((payment) => payment.classification === "verified-x402")) return "verified-x402";
  if (payments.some((payment) => payment.classification === "attributed-x402")) return "attributed-x402";
  return "possible-x402";
}

function providerHistoryInterpretation(
  classification: Extract<TransferClassification, "verified-x402" | "attributed-x402" | "possible-x402">,
  name: string,
): string {
  if (classification === "verified-x402") {
    return `A live x402 402 challenge names this payTo address, so payments to ${name} are high-confidence provider usage.`;
  }
  if (classification === "attributed-x402") {
    return `Payments map to ${name} through the provider catalog, but this report did not prove the exact HTTP endpoint called by the wallet.`;
  }
  return "Payments fit common x402 pricing, but no provider domain or live x402 challenge has been linked to this recipient yet.";
}

function buildProviderHistory(analysis: WalletAnalysis): ProviderHistoryItem[] {
  const grouped = new Map<string, Transfer[]>();
  for (const payment of analysis.x402Payments) {
    const key = payment.provider ?? payment.to;
    grouped.set(key, [...(grouped.get(key) ?? []), payment]);
  }

  return [...grouped.entries()]
    .map(([name, payments]) => {
      const provider = payments[0];
      const catalog = provider.providerId
        ? getX402ProviderCatalog().find((item) => item.id === provider.providerId)
        : undefined;
      const total = payments.reduce((sum, payment) => sum + payment.amount, 0);
      const confidence = minConfidence(payments.map((payment) => payment.confidence));
      const classification = providerHistoryClassification(payments);
      return {
        provider: name,
        providerId: provider.providerId,
        domain: provider.providerDomain ?? catalog?.domain,
        category: provider.category ?? catalog?.category ?? "unknown",
        payments: payments.length,
        totalUSDC: total.toFixed(6),
        firstBlock: payments[0].blockNumber,
        lastBlock: payments[payments.length - 1].blockNumber,
        confidence,
        classification,
        attributionSource: provider.attributionSource,
        confidenceEvidence: payments.flatMap((payment) => payment.attributionEvidence ?? []),
        evidence: payments.slice(-5).map(evidenceFromTransfer),
        interpretation: providerHistoryInterpretation(classification, name),
      };
    })
    .sort((a, b) => b.payments - a.payments || Number(b.totalUSDC) - Number(a.totalUSDC));
}

function buildTradeBehavior(transfers: Transfer[]): ExposureReport["tradeAndDeFiBehavior"] {
  const defiTransfers = transfers.filter((transfer) => transfer.classification === "non-x402-defi");
  const evidence = defiTransfers.slice(-10).map(evidenceFromTransfer);

  const kinds = new Set(defiTransfers.map((transfer) => transfer.counterpartyKind));
  const likelyActivities: string[] = [];
  if (kinds.has("dex-router") || kinds.has("aggregator")) {
    likelyActivities.push("Token swaps or route-based trading on Base");
  }
  if (kinds.has("bridge")) likelyActivities.push("Bridge funding or cross-chain movement");
  if (kinds.has("lending")) likelyActivities.push("Lending, collateral, or yield activity");
  if (likelyActivities.length === 0) {
    likelyActivities.push("No high-confidence trading/yield pattern found in scanned USDC transfers");
  }

  return {
    likelyActivities,
    confidence: defiTransfers.length > 0 ? "medium" : "low",
    evidence,
    explanation:
      defiTransfers.length > 0
        ? "Classified from transfers to known Base routers and infrastructure contracts. Exact trade intent requires calldata/log decoding beyond USDC transfer history."
        : "The current v1 report scans outgoing Base USDC transfers; it does not claim a full portfolio or PnL reconstruction.",
  };
}

async function buildRiskExposure(
  analysis: WalletAnalysis,
  screeningProvider: SanctionsProvider,
): Promise<ExposureReport["riskExposure"]> {
  const directMatches: ExposureReport["riskExposure"]["directMatches"] = [];
  const seen = new Set<string>();
  const candidates = [analysis.address, ...analysis.transfers.map((transfer) => transfer.to)];

  for (const candidate of candidates) {
    const checksum = getAddress(candidate) as `0x${string}`;
    const lower = checksum.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    const reason = screeningProvider.screenAddress
      ? await screeningProvider.screenAddress(checksum)
      : screeningProvider.reasonFor(checksum);
    if (reason) {
      directMatches.push({
        address: checksum,
        reason,
        label: reason === "ofac-sdn-direct" ? "Direct OFAC SDN address match" : "Direct zBase policy blocklist match",
        severity: "blocked-direct",
      });
    }
  }

  return {
    directMatches,
    proximityWarnings: [],
    disclaimer:
      "Direct matches are exact address matches against the configured sanctions/policy provider. One-hop proximity is risk exposure, not a sanctions designation.",
  };
}

function buildLikelyNextActions(analysis: WalletAnalysis, providerHistory: ProviderHistoryItem[]): string[] {
  const actions: string[] = [];
  const repeatProvider = providerHistory.find((item) => item.payments >= 3);
  if (repeatProvider) {
    actions.push(`Likely to keep calling ${repeatProvider.provider}; cadence and spend are already visible.`);
  }
  if (providerHistory.some((item) => item.category === "market-data" || item.category === "data-api")) {
    actions.push("Likely to query data APIs before trading, enrichment, or agent decision loops.");
  }
  if (analysis.x402PaymentsDetected > 5) {
    actions.push("Likely to add more paid endpoints unless payment routing is privatized.");
  }
  if (actions.length === 0) actions.push("Not enough x402 history to make a strong next-action prediction.");
  return actions;
}

function buildRecommendations(analysis: WalletAnalysis, riskExposure: ExposureReport["riskExposure"]): string[] {
  const recommendations: string[] = [];
  if (analysis.x402PaymentsDetected > 0) {
    recommendations.push("Route future x402 settles through zBase so the payer wallet no longer appears in provider-payment transfers.");
  }
  if (Object.keys(analysis.providerCounts).length > 2) {
    recommendations.push("Consolidate agent payment policy: provider allowlists and spend caps reduce accidental strategy leakage.");
  }
  if (riskExposure.directMatches.length > 0) {
    recommendations.push("Do not provide private settlement to direct blocked-list matches; require manual compliance review.");
  }
  if (analysis.x402PaymentsDetected === 0) {
    recommendations.push("Keep the wallet clean by using private settlement before adopting paid x402 services at scale.");
  }
  recommendations.push("Use this report as a directional exposure map, not a legal sanctions opinion or trading-tax report.");
  return recommendations;
}

export async function buildExposureReport(
  address: string,
  options: AnalyzeWalletOptions & { reportMode?: "full" | "redacted" } = {},
): Promise<ExposureReport> {
  const analysis = await analyzeWallet(address, options);
  const providerHistory = buildProviderHistory(analysis);
  const tradeAndDeFiBehavior = buildTradeBehavior(analysis.transfers);
  const screeningProvider = options.screeningProvider ?? staticFallbackProvider();
  const riskExposure = await buildRiskExposure(analysis, screeningProvider);
  const verifiedX402Payments = analysis.verifiedX402Payments.map(evidenceFromTransfer);
  const attributedX402Payments = analysis.attributedX402Payments.map(evidenceFromTransfer);
  const possibleX402Payments = analysis.possibleX402Payments.map(evidenceFromTransfer);
  const nonX402DeFiActivity = analysis.nonX402DeFiActivity.map(evidenceFromTransfer);
  const attributionChecks = analysis.transfers.flatMap((transfer) => transfer.attributionEvidence ?? []);
  const evidence = [
    ...verifiedX402Payments,
    ...attributedX402Payments,
    ...possibleX402Payments,
    ...providerHistory.flatMap((provider) => provider.evidence),
    ...tradeAndDeFiBehavior.evidence,
  ].slice(0, 50);
  const reportMode = options.reportMode ?? "full";
  const confidence =
    analysis.verifiedX402Payments.length > 0
      ? "high"
      : analysis.attributedX402Payments.length > 0
        ? "medium"
        : analysis.possibleX402Payments.length > 0
          ? "low"
          : "medium";
  const headline =
    analysis.verifiedX402Payments.length > 0
      ? `${analysis.verifiedX402Payments.length} verified and ${analysis.attributedX402Payments.length} attributed x402 payments expose provider usage.`
      : analysis.attributedX402Payments.length > 0
        ? `${analysis.attributedX402Payments.length} attributed x402 payments expose provider usage; endpoint-level proof is not available yet.`
        : analysis.possibleX402Payments.length > 0
          ? `${analysis.possibleX402Payments.length} possible x402-sized payments need provider attribution before they should be treated as confirmed x402 usage.`
          : "No x402 payment pattern found in the scanned Base USDC window.";

  return {
    schemaVersion: 1,
    address: analysis.address,
    generatedAt: new Date().toISOString(),
    network: "base",
    summary: {
      headline,
      riskScore: analysis.riskScore,
      riskLevel: analysis.riskLevel,
      confidence,
      reportMode,
    },
    walletExposure: {
      totalTransfersScanned: analysis.totalTransfers,
      x402PaymentsDetected: analysis.x402PaymentsDetected,
      verifiedX402Payments: analysis.verifiedX402Payments.length,
      attributedX402Payments: analysis.attributedX402Payments.length,
      possibleX402Payments: analysis.possibleX402Payments.length,
      totalX402SpendUSDC: analysis.totalSpendVisible,
      uniqueProviders: Object.keys(analysis.providerCounts).length,
      scannedBlocks: analysis.scannedBlocks,
    },
    verifiedX402Payments,
    attributedX402Payments,
    possibleX402Payments,
    nonX402DeFiActivity,
    x402ProviderHistory: providerHistory,
    tradeAndDeFiBehavior,
    riskExposure,
    likelyNextActions: buildLikelyNextActions(analysis, providerHistory),
    recommendations: buildRecommendations(analysis, riskExposure),
    evidence,
    attributionChecks,
    providerCatalog: getX402ProviderCatalog().map(({ id, name, domain, category, chains, confidence, source, paymentRequirements }) => ({
      id,
      name,
      domain,
      category,
      chains,
      confidence,
      source,
      paymentRequirements,
    })),
  };
}

export function redactExposureReport(report: ExposureReport): ExposureReport {
  const redactProviderName = (item: ProviderHistoryItem): string =>
    item.category === "unknown" ? "Unknown x402-like payment" : `Known ${item.category} x402 provider`;
  const redactConfidenceEvidence = (evidence: X402ConfidenceEvidence): X402ConfidenceEvidence => ({
    ...evidence,
    matchedPayTo: evidence.matchedPayTo ? "0x0000000000000000000000000000000000000000" : undefined,
    resourceUrl: evidence.resourceUrl ? "hidden in preview" : undefined,
    sourceUrl: evidence.sourceUrl ? "hidden in preview" : undefined,
  });
  const redactEvidence = (evidence: ExposureEvidence): ExposureEvidence => ({
    ...evidence,
    txHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
    counterparty: "0x0000000000000000000000000000000000000000",
    matchedPayTo: evidence.matchedPayTo ? "0x0000000000000000000000000000000000000000" : undefined,
    resourceUrl: evidence.resourceUrl ? "hidden in preview" : undefined,
    sourceUrl: evidence.sourceUrl ? "hidden in preview" : undefined,
    confidenceEvidence: evidence.confidenceEvidence?.map(redactConfidenceEvidence),
    explanation: `${evidence.explanation} Exact transaction and counterparty hidden in preview.`,
  });
  return {
    ...report,
    summary: { ...report.summary, reportMode: "redacted" },
    x402ProviderHistory: report.x402ProviderHistory.map((item) => ({
      ...item,
      provider: redactProviderName(item),
      providerId: undefined,
      domain: undefined,
      interpretation:
        item.confidence === "high"
          ? "A named provider was detected, but its identity and exact history are hidden in the preview."
          : "A possible x402-sized payment was detected, but exact history is hidden in the preview.",
      evidence: item.evidence.slice(0, 1).map(redactEvidence),
    })),
    tradeAndDeFiBehavior: {
      ...report.tradeAndDeFiBehavior,
      evidence: report.tradeAndDeFiBehavior.evidence.slice(0, 3).map(redactEvidence),
    },
    verifiedX402Payments: report.verifiedX402Payments.slice(0, 3).map(redactEvidence),
    attributedX402Payments: report.attributedX402Payments.slice(0, 3).map(redactEvidence),
    possibleX402Payments: report.possibleX402Payments.slice(0, 3).map(redactEvidence),
    nonX402DeFiActivity: report.nonX402DeFiActivity.slice(0, 3).map(redactEvidence),
    riskExposure: {
      ...report.riskExposure,
      directMatches: report.riskExposure.directMatches.map((match) => ({
        ...match,
        address: "0x0000000000000000000000000000000000000000",
      })),
    },
    evidence: report.evidence.slice(0, 5).map(redactEvidence),
    attributionChecks: report.attributionChecks.slice(0, 10).map(redactConfidenceEvidence),
  };
}
