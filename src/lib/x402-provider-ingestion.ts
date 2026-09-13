import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import { getAddress, isAddress } from "viem";
import type { X402AttributionSource, X402ChainId, X402PaymentRequirementRecord } from "@/lib/x402-provider-catalog";

export interface X402ChallengeIngestionResult {
  endpoint: string;
  status: number;
  paymentRequired?: PaymentRequired;
  requirements: X402PaymentRequirementRecord[];
  error?: string;
}

function parsePaymentRequiredHeader(header: string | null): PaymentRequired | null {
  if (!header) return null;
  try {
    return decodePaymentRequiredHeader(header);
  } catch {
    return null;
  }
}

async function parsePaymentRequiredBody(response: Response): Promise<PaymentRequired | null> {
  try {
    const body = await response.clone().json();
    if (body?.x402?.accepts) return body.x402 as PaymentRequired;
    if (body?.accepts) return body as PaymentRequired;
  } catch {
    return null;
  }
  return null;
}

function validChain(value: string): value is X402ChainId {
  return (
    value === "eip155:8453" ||
    value === "eip155:84532" ||
    value === "solana:mainnet" ||
    value === "solana:devnet"
  );
}

function requirementRecords(args: {
  endpoint: string;
  paymentRequired: PaymentRequired;
  source: X402AttributionSource;
  sourceUrl?: string;
  now: string;
}): X402PaymentRequirementRecord[] {
  return args.paymentRequired.accepts
    .filter((requirement) => validChain(requirement.network))
    .filter((requirement) => isAddress(requirement.payTo))
    .map((requirement) => ({
      chain: requirement.network as X402ChainId,
      asset: isAddress(requirement.asset) ? (getAddress(requirement.asset) as `0x${string}`) : undefined,
      payTo: getAddress(requirement.payTo) as `0x${string}`,
      amountAtomic: requirement.amount,
      endpoint: args.endpoint,
      resourceUrl: args.paymentRequired.resource?.url,
      source: args.source,
      sourceUrl: args.sourceUrl ?? args.endpoint,
      lastVerifiedAt: args.now,
      confidence: args.source === "402-challenge" ? "high" : "medium",
    }));
}

export async function ingestX402Challenge(
  endpoint: string,
  options: { source?: X402AttributionSource; signal?: AbortSignal } = {},
): Promise<X402ChallengeIngestionResult> {
  const source = options.source ?? "402-challenge";
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return { endpoint, status: 0, requirements: [], error: "Invalid endpoint URL" };
  }
  if (url.protocol !== "https:") {
    return { endpoint, status: 0, requirements: [], error: "Provider challenge ingestion requires HTTPS" };
  }

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: options.signal ?? AbortSignal.timeout(5000),
    });
    const paymentRequired =
      parsePaymentRequiredHeader(response.headers.get("payment-required")) ??
      (await parsePaymentRequiredBody(response));
    if (!paymentRequired) {
      return {
        endpoint,
        status: response.status,
        requirements: [],
        error: response.status === 402 ? "402 response did not contain parseable x402 payment requirements" : "Endpoint did not return x402 payment requirements",
      };
    }
    return {
      endpoint,
      status: response.status,
      paymentRequired,
      requirements: requirementRecords({
        endpoint,
        paymentRequired,
        source,
        sourceUrl: endpoint,
        now: new Date().toISOString(),
      }),
    };
  } catch (error) {
    return {
      endpoint,
      status: 0,
      requirements: [],
      error: (error as Error).message.slice(0, 240),
    };
  }
}
