import { facilitator as coinbaseFacilitator } from "@coinbase/x402";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  HTTPFacilitatorClient,
} from "@x402/core/http";
import type { PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { NextResponse } from "next/server";
import { getActiveStack } from "@/lib/contracts";
import { isFacilitatorNetwork, type FacilitatorNetwork } from "@/lib/facilitator-authz";

const BASE_MAINNET_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
// ETHONLINE-2026: Ethereum Sepolia USDC (verified on-chain), EIP-712 domain
// name "USDC" / version "2".
const ETH_SEPOLIA_USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const DEFAULT_TREASURY = "0xDbAA23601A95a01ee9B90160F6aA784CBE4E0f21";

// Keyed lookup of the USDC env-var override + fallback per network. Fails
// closed by construction: Record<FacilitatorNetwork, ...> requires every
// network in the union to have an entry, so an unhandled network is a
// compile error rather than a silent Sepolia fallback.
const USDC_ENV_FALLBACK_BY_NETWORK: Record<
  FacilitatorNetwork,
  { envVar: string | undefined; fallback: string }
> = {
  "eip155:8453": { envVar: process.env.BASE_MAINNET_USDC, fallback: BASE_MAINNET_USDC },
  "eip155:84532": { envVar: process.env.USDC_CONTRACT_ADDRESS, fallback: BASE_SEPOLIA_USDC },
  "eip155:11155111": { envVar: process.env.ETH_SEPOLIA_USDC, fallback: ETH_SEPOLIA_USDC },
};

export interface VerifiedExposurePayment {
  mode: "x402" | "dev";
  amountAtomic: string;
  network: string;
  payer?: string;
  paymentPayload?: PaymentPayload;
  paymentRequirements: PaymentRequirements;
}

export interface ExposurePaymentConfig {
  amountAtomic: string;
  displayPrice: string;
  network: FacilitatorNetwork;
  asset: `0x${string}`;
  payTo: `0x${string}`;
  maxTimeoutSeconds: number;
}

function configuredAddress(value: string | undefined, fallback: string, name: string): `0x${string}` {
  const candidate = value?.trim();
  if (!candidate) return fallback as `0x${string}`;
  if (!/^0x[a-fA-F0-9]{40}$/.test(candidate)) {
    throw new Error(`${name} must be a 0x-prefixed EVM address`);
  }
  return candidate as `0x${string}`;
}

function configuredPositiveInteger(value: string | undefined, fallback: string, name: string): string {
  const candidate = value?.trim() || fallback;
  if (!/^[1-9][0-9]*$/.test(candidate)) {
    throw new Error(`${name} must be a positive integer string`);
  }
  return candidate;
}

function configuredTimeoutSeconds(value: string | undefined): number {
  const candidate = Number(value ?? "300");
  if (!Number.isSafeInteger(candidate) || candidate <= 0) {
    throw new Error("ZBASE_EXPOSURE_PAYMENT_TIMEOUT_SECONDS must be a positive integer");
  }
  return candidate;
}

export function exposurePaymentConfig(): ExposurePaymentConfig {
  const stack = getActiveStack();
  const configuredNetwork = process.env.ZBASE_EXPOSURE_NETWORK;
  const network: FacilitatorNetwork = isFacilitatorNetwork(configuredNetwork)
    ? configuredNetwork
    : stack.facilitatorNetwork;
  const { envVar, fallback } = USDC_ENV_FALLBACK_BY_NETWORK[network];
  const asset = configuredAddress(
    process.env.ZBASE_EXPOSURE_USDC ?? envVar,
    fallback,
    "ZBASE_EXPOSURE_USDC",
  );
  return {
    amountAtomic: configuredPositiveInteger(
      process.env.ZBASE_EXPOSURE_PRICE_ATOMIC,
      "1000000",
      "ZBASE_EXPOSURE_PRICE_ATOMIC",
    ),
    displayPrice: process.env.ZBASE_EXPOSURE_PRICE_DISPLAY ?? "$1.00",
    network,
    asset,
    payTo: configuredAddress(
      process.env.ZBASE_EXPOSURE_PAY_TO ?? process.env.ZBASE_FEE_TREASURY,
      DEFAULT_TREASURY,
      "ZBASE_EXPOSURE_PAY_TO",
    ),
    maxTimeoutSeconds: configuredTimeoutSeconds(process.env.ZBASE_EXPOSURE_PAYMENT_TIMEOUT_SECONDS),
  };
}

export function exposurePaymentRequirements(requestUrl: string): PaymentRequirements {
  const cfg = exposurePaymentConfig();
  return {
    scheme: "exact",
    network: cfg.network,
    amount: cfg.amountAtomic,
    asset: cfg.asset,
    payTo: cfg.payTo,
    maxTimeoutSeconds: cfg.maxTimeoutSeconds,
    extra: {
      name: "zBase Exposure Check",
      displayPrice: cfg.displayPrice,
      report: "wallet-exposure",
      resource: requestUrl,
    },
  };
}

export function exposurePaymentRequired(requestUrl: string, error?: string): PaymentRequired {
  return {
    x402Version: 2,
    error,
    resource: {
      url: requestUrl,
      description: "zBase wallet exposure report",
      mimeType: "application/json",
    },
    accepts: [exposurePaymentRequirements(requestUrl)],
    extensions: {
      zbase: {
        product: "exposure-report",
        redactedPreview: "/api/zbase/privacy-check",
      },
    },
  };
}

function paymentRequiredResponse(requestUrl: string, error?: string): NextResponse {
  const paymentRequired = exposurePaymentRequired(requestUrl, error);
  return NextResponse.json(
    {
      error: "Payment Required",
      message: error ?? "Submit an x402 PAYMENT-SIGNATURE header to unlock the full exposure report.",
      x402: paymentRequired,
    },
    {
      status: 402,
      headers: {
        "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired),
        "Cache-Control": "no-store",
      },
    },
  );
}

function acceptedMatchesRequirements(accepted: PaymentRequirements, required: PaymentRequirements): boolean {
  return (
    accepted.scheme === required.scheme &&
    accepted.network === required.network &&
    accepted.amount === required.amount &&
    accepted.asset.toLowerCase() === required.asset.toLowerCase() &&
    accepted.payTo.toLowerCase() === required.payTo.toLowerCase() &&
    accepted.maxTimeoutSeconds === required.maxTimeoutSeconds &&
    accepted.extra?.name === required.extra?.name &&
    accepted.extra?.displayPrice === required.extra?.displayPrice &&
    accepted.extra?.report === required.extra?.report &&
    accepted.extra?.resource === required.extra?.resource
  );
}

function productionRuntime(): boolean {
  return process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production";
}

function devPaymentAllowed(request: Request): boolean {
  const token = request.headers.get("x-zbase-dev-payment");
  if (!token) return false;
  if (productionRuntime()) return false;
  const expected = process.env.ZBASE_EXPOSURE_DEV_PAYMENT_TOKEN;
  if (expected) return token === expected;
  return process.env.ZBASE_EXPOSURE_ALLOW_DEV_PAYMENT === "true" && token === "dev";
}

function facilitatorClient(): HTTPFacilitatorClient {
  const overrideUrl = process.env.ZBASE_EXPOSURE_FACILITATOR_URL;
  if (overrideUrl) return new HTTPFacilitatorClient({ url: overrideUrl });
  return new HTTPFacilitatorClient(coinbaseFacilitator);
}

export async function requireExposurePayment(
  request: Request,
): Promise<{ ok: true; payment: VerifiedExposurePayment } | { ok: false; response: NextResponse }> {
  const requestUrl = request.url;
  const required = exposurePaymentRequirements(requestUrl);

  if (devPaymentAllowed(request)) {
    return {
      ok: true,
      payment: {
        mode: "dev",
        amountAtomic: required.amount,
        network: required.network,
        paymentRequirements: required,
      },
    };
  }

  const signatureHeader =
    request.headers.get("payment-signature") ?? request.headers.get("PAYMENT-SIGNATURE");
  if (!signatureHeader) {
    return { ok: false, response: paymentRequiredResponse(requestUrl) };
  }

  let paymentPayload: PaymentPayload;
  try {
    paymentPayload = decodePaymentSignatureHeader(signatureHeader);
  } catch {
    return { ok: false, response: paymentRequiredResponse(requestUrl, "Invalid PAYMENT-SIGNATURE header") };
  }

  if (!acceptedMatchesRequirements(paymentPayload.accepted, required)) {
    return {
      ok: false,
      response: paymentRequiredResponse(requestUrl, "Payment payload does not match this report price or recipient"),
    };
  }

  try {
    const verified = await facilitatorClient().verify(paymentPayload, required);
    if (!verified.isValid) {
      return {
        ok: false,
        response: paymentRequiredResponse(requestUrl, verified.invalidMessage ?? verified.invalidReason ?? "Payment invalid"),
      };
    }
    return {
      ok: true,
      payment: {
        mode: "x402",
        amountAtomic: required.amount,
        network: required.network,
        payer: verified.payer,
        paymentPayload,
        paymentRequirements: required,
      },
    };
  } catch (error) {
    return {
      ok: false,
      response: paymentRequiredResponse(
        requestUrl,
        `Payment verification unavailable: ${(error as Error).message.slice(0, 240)}`,
      ),
    };
  }
}

export async function settleExposurePayment(payment: VerifiedExposurePayment): Promise<SettleResponse | null> {
  if (payment.mode !== "x402" || !payment.paymentPayload) return null;
  const settlement = await facilitatorClient().settle(payment.paymentPayload, payment.paymentRequirements);
  if (!settlement.success) {
    throw new Error(settlement.errorMessage ?? settlement.errorReason ?? "Payment settlement failed");
  }
  return settlement;
}

export function paymentResponseHeaders(settlement: SettleResponse | null): HeadersInit {
  if (!settlement) return {};
  return {
    "PAYMENT-RESPONSE": encodePaymentResponseHeader(settlement),
  };
}
