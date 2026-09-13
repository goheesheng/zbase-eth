import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import { getAddress, isAddress } from "viem";
import {
  type X402ChainId,
  type X402ProviderCategory,
} from "@/lib/x402-provider-catalog";
import { ingestX402Challenge } from "@/lib/x402-provider-ingestion";

export type X402ReportAttributionSource =
  | "bazaar"
  | "x402scan"
  | "live-402"
  | "onchain-heuristic"
  | "manual-catalog";

export type X402AttributionCheckStatus =
  | "matched"
  | "not-found"
  | "payment-required"
  | "failed"
  | "skipped";

export interface X402ConfidenceEvidence {
  source: X402ReportAttributionSource;
  status: X402AttributionCheckStatus;
  confidence: "high" | "medium" | "low";
  provider?: string;
  providerDomain?: string;
  category?: X402ProviderCategory;
  matchedPayTo?: `0x${string}`;
  matchedAmount?: string;
  resourceUrl?: string;
  sourceUrl?: string;
  lastVerifiedAt: string;
  whatWeCannotProve?: string;
  error?: string;
}

export interface X402ResolvedAttribution {
  payTo: `0x${string}`;
  classification?: "verified-x402" | "attributed-x402";
  confidence?: "high" | "medium" | "low";
  provider?: string;
  providerDomain?: string;
  category?: X402ProviderCategory;
  evidence: X402ConfidenceEvidence[];
}

export interface ExternalAttributionOptions {
  enabled?: boolean;
  fetchFn?: typeof fetch;
  preloaded?: X402ResolvedAttribution[];
  liveProbeEndpoints?: string[];
  bazaar?: {
    enabled?: boolean;
    url?: string;
    pageSize?: number;
    maxPages?: number;
  };
  x402scan?: {
    enabled?: boolean;
    url?: string;
    pageSize?: number;
    maxPages?: number;
    paymentSignature?: string;
  };
}

const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const DEFAULT_BAZAAR_URL = "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources";
const DEFAULT_X402SCAN_MERCHANTS_URL = "https://www.x402scan.com/api/x402/merchants";

function nowIso(): string {
  return new Date().toISOString();
}

function maybeAddress(value: unknown): `0x${string}` | null {
  return typeof value === "string" && isAddress(value) ? (getAddress(value) as `0x${string}`) : null;
}

function domainFromResource(resourceUrl: string | undefined): string | undefined {
  if (!resourceUrl) return undefined;
  try {
    return new URL(resourceUrl).hostname;
  } catch {
    return undefined;
  }
}

function providerNameFromResource(resourceUrl: string | undefined, fallback: string): string {
  const domain = domainFromResource(resourceUrl);
  return domain ?? fallback;
}

function targetSet(targetPayTos: string[]): Set<string> {
  return new Set(
    targetPayTos
      .map((address) => maybeAddress(address))
      .filter((address): address is `0x${string}` => Boolean(address))
      .map((address) => address.toLowerCase()),
  );
}

function appendEvidence(
  map: Map<string, X402ResolvedAttribution>,
  payTo: `0x${string}`,
  attribution: X402ResolvedAttribution,
) {
  const key = payTo.toLowerCase();
  const existing = map.get(key);
  if (!existing) {
    map.set(key, attribution);
    return;
  }
  const stronger =
    !attribution.classification ||
    existing.classification === "verified-x402" ||
    (existing.classification === attribution.classification && existing.confidence === "high")
      ? existing
      : attribution;
  stronger.evidence = [...existing.evidence, ...attribution.evidence];
  map.set(key, stronger);
}

function buildMatch(args: {
  source: "bazaar" | "x402scan" | "live-402";
  payTo: `0x${string}`;
  amount?: string;
  resourceUrl?: string;
  provider?: string;
  category?: X402ProviderCategory;
  sourceUrl?: string;
  lastVerifiedAt?: string;
}): X402ResolvedAttribution {
  const provider = args.provider ?? providerNameFromResource(args.resourceUrl, args.payTo);
  const providerDomain = domainFromResource(args.resourceUrl);
  const classification = args.source === "live-402" ? "verified-x402" : "attributed-x402";
  const confidence = args.source === "live-402" ? "high" : "medium";
  return {
    payTo: args.payTo,
    classification,
    confidence,
    provider,
    providerDomain,
    category: args.category ?? "unknown",
    evidence: [
      {
        source: args.source,
        status: "matched",
        confidence,
        provider,
        providerDomain,
        category: args.category ?? "unknown",
        matchedPayTo: args.payTo,
        matchedAmount: args.amount,
        resourceUrl: args.resourceUrl,
        sourceUrl: args.sourceUrl,
        lastVerifiedAt: args.lastVerifiedAt ?? nowIso(),
        whatWeCannotProve:
          args.source === "live-402"
            ? undefined
            : "This source maps the payTo to a provider/resource, but it does not prove which exact HTTP request the wallet made.",
      },
    ],
  };
}

function noMatchEvidence(source: "bazaar" | "x402scan" | "live-402", error?: string): X402ConfidenceEvidence {
  return {
    source,
    status: error ? "failed" : "not-found",
    confidence: "low",
    lastVerifiedAt: nowIso(),
    error,
    whatWeCannotProve: error
      ? "The attribution source could not be queried successfully."
      : "No payTo mapping was found in this source for the recipient address.",
  };
}

function x402ScanPaymentRequiredEvidence(paymentRequired: PaymentRequired): X402ConfidenceEvidence {
  const accepts = paymentRequired.accepts?.[0];
  return {
    source: "x402scan",
    status: "payment-required",
    confidence: "low",
    matchedPayTo: maybeAddress(accepts?.payTo) ?? undefined,
    matchedAmount: accepts?.amount,
    resourceUrl: paymentRequired.resource?.url,
    sourceUrl: paymentRequired.resource?.url,
    lastVerifiedAt: nowIso(),
    whatWeCannotProve:
      "x402scan requires its own x402 payment before it returns merchant attribution data. No merchant mapping was unlocked in this run.",
  };
}

function parsePaymentRequired(response: Response): PaymentRequired | null {
  const header = response.headers.get("payment-required");
  if (!header) return null;
  try {
    return decodePaymentRequiredHeader(header);
  } catch {
    return null;
  }
}

type BazaarResource = {
  accepts?: Array<{
    amount?: string;
    asset?: string;
    network?: string;
    payTo?: string;
    recipient?: string;
  }>;
  resource?: string;
  serviceName?: string;
  description?: string;
  tags?: string[];
  lastUpdated?: string;
};

export async function fetchBazaarAttributions(
  targetPayTos: string[],
  options: ExternalAttributionOptions = {},
): Promise<{ matches: Map<string, X402ResolvedAttribution>; checks: X402ConfidenceEvidence[] }> {
  const targets = targetSet(targetPayTos);
  const matches = new Map<string, X402ResolvedAttribution>();
  if (targets.size === 0) return { matches, checks: [] };

  const fetchFn = options.fetchFn ?? fetch;
  const url = options.bazaar?.url ?? process.env.ZBASE_BAZAAR_DISCOVERY_URL ?? DEFAULT_BAZAAR_URL;
  const pageSize = options.bazaar?.pageSize ?? Number(process.env.ZBASE_BAZAAR_PAGE_SIZE ?? 1000);
  const maxPages = options.bazaar?.maxPages ?? Number(process.env.ZBASE_BAZAAR_MAX_PAGES ?? 30);
  const checks: X402ConfidenceEvidence[] = [];

  try {
    let offset = 0;
    let total = Number.POSITIVE_INFINITY;
    for (let page = 0; page < maxPages && offset < total; page += 1) {
      const requestUrl = new URL(url);
      requestUrl.searchParams.set("type", "http");
      requestUrl.searchParams.set("limit", String(pageSize));
      requestUrl.searchParams.set("offset", String(offset));
      const response = await fetchFn(requestUrl, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(Number(process.env.ZBASE_BAZAAR_FETCH_TIMEOUT_MS ?? 10000)),
      });
      if (!response.ok) throw new Error(`Bazaar discovery returned HTTP ${response.status}`);
      const body = await response.json();
      const items = (body.items ?? []) as BazaarResource[];
      total = Number(body.pagination?.total ?? items.length);
      for (const item of items) {
        for (const requirement of item.accepts ?? []) {
          const payTo = maybeAddress(requirement.payTo ?? requirement.recipient);
          if (!payTo || !targets.has(payTo.toLowerCase())) continue;
          appendEvidence(
            matches,
            payTo,
            buildMatch({
              source: "bazaar",
              payTo,
              amount: requirement.amount,
              resourceUrl: item.resource,
              provider: item.serviceName ?? domainFromResource(item.resource),
              category: categoryFromText(`${item.serviceName ?? ""} ${item.description ?? ""} ${(item.tags ?? []).join(" ")}`),
              sourceUrl: requestUrl.toString(),
              lastVerifiedAt: item.lastUpdated,
            }),
          );
        }
      }
      if ([...targets].every((target) => matches.has(target))) break;
      offset += pageSize;
    }
    for (const target of targets) {
      if (!matches.has(target)) checks.push(noMatchEvidence("bazaar"));
    }
  } catch (error) {
    checks.push(noMatchEvidence("bazaar", (error as Error).message.slice(0, 240)));
  }

  return { matches, checks };
}

function categoryFromText(text: string): X402ProviderCategory {
  const lower = text.toLowerCase();
  if (lower.includes("yield") || lower.includes("defi")) return "market-data";
  if (lower.includes("market") || lower.includes("stock") || lower.includes("price")) return "market-data";
  if (lower.includes("agent") || lower.includes("mcp")) return "agent-platform";
  if (lower.includes("ai") || lower.includes("inference") || lower.includes("llm")) return "ai-inference";
  if (lower.includes("enrich") || lower.includes("identity")) return "enrichment";
  if (lower.includes("data") || lower.includes("api")) return "data-api";
  return "unknown";
}

function collectAddressMatches(value: unknown, targets: Set<string>, path: string[] = []): Array<{ path: string[]; object: Record<string, unknown>; address: `0x${string}` }> {
  const matches: Array<{ path: string[]; object: Record<string, unknown>; address: `0x${string}` }> = [];
  if (!value || typeof value !== "object") return matches;
  if (Array.isArray(value)) {
    value.forEach((item, index) => matches.push(...collectAddressMatches(item, targets, [...path, String(index)])));
    return matches;
  }
  const object = value as Record<string, unknown>;
  for (const [key, nested] of Object.entries(object)) {
    const address = maybeAddress(nested);
    if (address && targets.has(address.toLowerCase())) {
      matches.push({ path: [...path, key], object, address });
    }
    matches.push(...collectAddressMatches(nested, targets, [...path, key]));
  }
  return matches;
}

export async function fetchX402ScanAttributions(
  targetPayTos: string[],
  options: ExternalAttributionOptions = {},
): Promise<{ matches: Map<string, X402ResolvedAttribution>; checks: X402ConfidenceEvidence[] }> {
  const targets = targetSet(targetPayTos);
  const matches = new Map<string, X402ResolvedAttribution>();
  if (targets.size === 0) return { matches, checks: [] };

  const fetchFn = options.fetchFn ?? fetch;
  const url = options.x402scan?.url ?? process.env.ZBASE_X402SCAN_MERCHANTS_URL ?? DEFAULT_X402SCAN_MERCHANTS_URL;
  const pageSize = options.x402scan?.pageSize ?? Number(process.env.ZBASE_X402SCAN_PAGE_SIZE ?? 100);
  const maxPages = options.x402scan?.maxPages ?? Number(process.env.ZBASE_X402SCAN_MAX_PAGES ?? 20);
  const paymentSignature = options.x402scan?.paymentSignature ?? process.env.ZBASE_X402SCAN_PAYMENT_SIGNATURE;
  const checks: X402ConfidenceEvidence[] = [];

  try {
    for (let page = 0; page < maxPages; page += 1) {
      const requestUrl = new URL(url);
      requestUrl.searchParams.set("chain", "base");
      requestUrl.searchParams.set("page", String(page));
      requestUrl.searchParams.set("page_size", String(pageSize));
      requestUrl.searchParams.set("sort_by", "volume");
      requestUrl.searchParams.set("timeframe", "30");
      const headers: Record<string, string> = { accept: "application/json" };
      if (paymentSignature) {
        headers["PAYMENT-SIGNATURE"] = paymentSignature;
        headers["X-PAYMENT"] = paymentSignature;
      }
      const response = await fetchFn(requestUrl, {
        headers,
        signal: AbortSignal.timeout(Number(process.env.ZBASE_X402SCAN_FETCH_TIMEOUT_MS ?? 10000)),
      });
      if (response.status === 402) {
        const paymentRequired = parsePaymentRequired(response);
        checks.push(
          paymentRequired
            ? x402ScanPaymentRequiredEvidence(paymentRequired)
            : noMatchEvidence("x402scan", "x402scan returned 402 without a parseable PAYMENT-REQUIRED header"),
        );
        break;
      }
      if (!response.ok) throw new Error(`x402scan returned HTTP ${response.status}`);
      const body = await response.json();
      const values = Array.isArray(body.items) ? body.items : Array.isArray(body.data) ? body.data : Array.isArray(body.merchants) ? body.merchants : [body];
      for (const match of collectAddressMatches(values, targets)) {
        const object = match.object;
        const resourceUrl =
          typeof object.resource === "string"
            ? object.resource
            : typeof object.url === "string"
              ? object.url
              : undefined;
        appendEvidence(
          matches,
          match.address,
          buildMatch({
            source: "x402scan",
            payTo: match.address,
            amount: typeof object.amount === "string" ? object.amount : undefined,
            resourceUrl,
            provider:
              typeof object.serviceName === "string"
                ? object.serviceName
                : typeof object.name === "string"
                  ? object.name
                  : typeof object.domain === "string"
                    ? object.domain
                    : undefined,
            sourceUrl: requestUrl.toString(),
          }),
        );
      }
      if ([...targets].every((target) => matches.has(target))) break;
      const totalPages = Number(body.total_pages ?? body.totalPages ?? body.pagination?.totalPages ?? maxPages);
      if (page + 1 >= totalPages) break;
    }
    for (const target of targets) {
      if (!matches.has(target) && !checks.some((check) => check.source === "x402scan")) {
        checks.push(noMatchEvidence("x402scan"));
      }
    }
  } catch (error) {
    checks.push(noMatchEvidence("x402scan", (error as Error).message.slice(0, 240)));
  }

  return { matches, checks };
}

export async function probeLive402Attributions(
  targetPayTos: string[],
  endpoints: string[],
): Promise<{ matches: Map<string, X402ResolvedAttribution>; checks: X402ConfidenceEvidence[] }> {
  const targets = targetSet(targetPayTos);
  const matches = new Map<string, X402ResolvedAttribution>();
  if (targets.size === 0 || endpoints.length === 0) return { matches, checks: [] };

  const checks: X402ConfidenceEvidence[] = [];
  for (const endpoint of [...new Set(endpoints)].slice(0, Number(process.env.ZBASE_LIVE_402_MAX_ENDPOINTS ?? 20))) {
    const result = await ingestX402Challenge(endpoint);
    if (result.error) {
      checks.push(noMatchEvidence("live-402", result.error));
      continue;
    }
    let matched = false;
    for (const requirement of result.requirements) {
      const payTo = maybeAddress(requirement.payTo);
      if (!payTo || !targets.has(payTo.toLowerCase())) continue;
      matched = true;
      appendEvidence(
        matches,
        payTo,
        buildMatch({
          source: "live-402",
          payTo,
          amount: requirement.amountAtomic,
          resourceUrl: requirement.resourceUrl ?? endpoint,
          provider: providerNameFromResource(requirement.resourceUrl ?? endpoint, payTo),
          sourceUrl: endpoint,
          lastVerifiedAt: requirement.lastVerifiedAt,
        }),
      );
    }
    if (!matched) checks.push(noMatchEvidence("live-402"));
  }

  return { matches, checks };
}

export async function resolveExternalX402Attributions(
  targetPayTos: string[],
  options: ExternalAttributionOptions = {},
): Promise<Map<string, X402ResolvedAttribution>> {
  const targets = targetSet(targetPayTos);
  const resolved = new Map<string, X402ResolvedAttribution>();
  for (const item of options.preloaded ?? []) {
    if (targets.has(item.payTo.toLowerCase())) appendEvidence(resolved, item.payTo, item);
  }
  if (options.enabled === false || targets.size === 0) return resolved;

  const bazaarEnabled =
    options.bazaar?.enabled ?? (options.enabled === true || process.env.ZBASE_ENABLE_BAZAAR_ATTRIBUTION === "true");
  const x402scanEnabled =
    options.x402scan?.enabled ?? (options.enabled === true || process.env.ZBASE_ENABLE_X402SCAN_ATTRIBUTION === "true");
  const liveEndpoints = [
    ...(options.liveProbeEndpoints ?? []),
    ...(process.env.ZBASE_EXPOSURE_PROBE_ENDPOINTS ?? "")
      .split(",")
      .map((endpoint) => endpoint.trim())
      .filter(Boolean),
  ];

  if (bazaarEnabled) {
    const bazaar = await fetchBazaarAttributions([...targets], options);
    for (const attribution of bazaar.matches.values()) appendEvidence(resolved, attribution.payTo, attribution);
    for (const check of bazaar.checks) appendUnmatchedEvidence(resolved, targets, check);
  }
  if (x402scanEnabled) {
    const x402scan = await fetchX402ScanAttributions([...targets], options);
    for (const attribution of x402scan.matches.values()) appendEvidence(resolved, attribution.payTo, attribution);
    for (const check of x402scan.checks) appendUnmatchedEvidence(resolved, targets, check);
  }

  const probeTargets = [...resolved.values()]
    .flatMap((attribution) => attribution.evidence.map((evidence) => evidence.resourceUrl))
    .filter((url): url is string => Boolean(url));
  const live = await probeLive402Attributions([...targets], [...liveEndpoints, ...probeTargets]);
  for (const attribution of live.matches.values()) appendEvidence(resolved, attribution.payTo, attribution);
  for (const check of live.checks) appendUnmatchedEvidence(resolved, targets, check);

  return resolved;
}

function appendUnmatchedEvidence(
  resolved: Map<string, X402ResolvedAttribution>,
  targets: Set<string>,
  evidence: X402ConfidenceEvidence,
) {
  for (const target of targets) {
    const existing = resolved.get(target);
    if (existing) {
      existing.evidence.push(evidence);
      continue;
    }
    resolved.set(target, {
      payTo: getAddress(target) as `0x${string}`,
      provider: `Unknown recipient (${target.slice(0, 6)}...${target.slice(-4)})`,
      category: "unknown",
      evidence: [evidence],
    });
  }
}

export function onchainHeuristicEvidence(args: {
  payTo: `0x${string}`;
  amountAtomic: string;
  amountUSDC: string;
}): X402ConfidenceEvidence {
  return {
    source: "onchain-heuristic",
    status: "matched",
    confidence: "low",
    matchedPayTo: args.payTo,
    matchedAmount: args.amountAtomic,
    lastVerifiedAt: nowIso(),
    whatWeCannotProve:
      `Only an on-chain ${args.amountUSDC} USDC transfer was observed. No provider domain, Bazaar item, x402scan merchant row, or live 402 challenge has confirmed this recipient.`,
  };
}

export function catalogEvidence(args: {
  source: "manual-catalog" | "bazaar" | "x402scan" | "live-402";
  payTo: `0x${string}`;
  amountAtomic?: string;
  resourceUrl?: string;
  provider: string;
  providerDomain?: string;
  category?: X402ProviderCategory;
  lastVerifiedAt?: string;
  whatWeCannotProve?: string;
}): X402ConfidenceEvidence {
  return {
    source: args.source,
    status: "matched",
    confidence: args.source === "live-402" ? "high" : "medium",
    provider: args.provider,
    providerDomain: args.providerDomain,
    category: args.category,
    matchedPayTo: args.payTo,
    matchedAmount: args.amountAtomic,
    resourceUrl: args.resourceUrl,
    lastVerifiedAt: args.lastVerifiedAt ?? nowIso(),
    whatWeCannotProve: args.whatWeCannotProve,
  };
}

export function chainMatchesBase(chain: X402ChainId | string | undefined): boolean {
  return chain === "eip155:8453";
}

export function isBaseUsdc(asset: string | undefined): boolean {
  return Boolean(asset && asset.toLowerCase() === BASE_USDC.toLowerCase());
}
