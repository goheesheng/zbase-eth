/**
 * private-x402-seller.ts — gate an API with x402; receive IMMEDIATELY to the
 * seller's existing wallet. Mirrors the standard-interface pattern in
 * exposure-payment.ts, but generic over any seller's SellerConfig.
 *
 * The buyer (zBase SDK `payAndFetch`) sends a standard `X-PAYMENT` header whose
 * base64 body is `{ x402Version, scheme, network, payload:{ signature,
 * authorization } }`. We decode it and map it into @x402/core's V2
 * `PaymentPayload` (`{ x402Version, accepted, payload }`) — the seller supplies
 * `accepted` from its own requirements — then verify + settle via a facilitator
 * (CDP by default; point `facilitatorUrl` at zBase to route the 5% take).
 *
 * NOTE (empirical): the wire↔@x402/core mapping + live CDP acceptance is the one
 * thing a mock can't prove — confirm with the Base Sepolia dry-run (plan §Verification).
 */
import { facilitator as coinbaseFacilitator } from "@coinbase/x402";
import { encodePaymentRequiredHeader, encodePaymentResponseHeader, HTTPFacilitatorClient } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse } from "@x402/core/types";
import { NextResponse } from "next/server";
import { createSeller, buildPaymentRequired, type Seller, type SellerConfig } from "@zbase-protocol/core";

/** Structural facilitator type — HTTPFacilitatorClient satisfies it, and so can a test mock. */
export type FacilitatorLike = {
  verify(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<VerifyResponse>;
  settle(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<SettleResponse>;
};

export interface VerifiedPrivatePayment {
  paymentPayload: PaymentPayload;
  requirements: PaymentRequirements;
  payer?: string;
  facilitator: FacilitatorLike;
  seller: Seller;
}

type GateResult =
  | { ok: true; payment: VerifiedPrivatePayment }
  | { ok: false; response: NextResponse };

/** Normalize a SellerConfig or an already-built Seller. */
function toSeller(config: SellerConfig | Seller): Seller {
  return "tokenName" in config && "priceAtomic" in config && typeof (config as Seller).network === "string"
    ? (config as Seller)
    : createSeller(config as SellerConfig);
}

/** The single `exact` requirements object the facilitator verifies against. */
function sellerRequirements(seller: Seller): PaymentRequirements {
  return {
    scheme: "exact",
    network: seller.network,
    asset: seller.asset,
    amount: seller.priceAtomic,
    payTo: seller.payTo,
    maxTimeoutSeconds: seller.maxTimeoutSeconds,
    extra: { name: seller.tokenName, version: seller.tokenVersion },
  };
}

function facilitatorFor(seller: Seller): FacilitatorLike {
  // createSeller defaults `facilitatorUrl` to zBase's facilitator, so sellers
  // route the 5% take through zBase by default. Pass facilitatorUrl:"" to opt
  // into CDP (empty string is falsy → the CDP fallback below).
  if (seller.facilitatorUrl) return new HTTPFacilitatorClient({ url: seller.facilitatorUrl });
  return new HTTPFacilitatorClient(coinbaseFacilitator);
}

function decodeXPayment(header: string): {
  x402Version?: number;
  payload?: { signature?: string; authorization?: { to?: string; value?: string } };
} {
  const json = Buffer.from(header, "base64").toString("utf8");
  return JSON.parse(json);
}

function paymentRequiredResponse(seller: Seller, resourceUrl: string, error?: string, extensions?: Record<string, unknown>): NextResponse {
  const body = buildPaymentRequired(seller, { resourceUrl, error, extensions });
  let headerValue = "";
  try {
    // @x402/core PaymentRequired shape is compatible (accepts[] with amount/extra).
    headerValue = encodePaymentRequiredHeader(body as never);
  } catch {
    headerValue = Buffer.from(JSON.stringify(body)).toString("base64");
  }
  // Standard x402 402: `accepts` at the TOP LEVEL (what buyers/parsers read),
  // plus the base64 PAYMENT-REQUIRED header for header-based clients.
  return NextResponse.json(body, {
    status: 402,
    headers: { "PAYMENT-REQUIRED": headerValue, "Cache-Control": "no-store" },
  });
}

/**
 * Gate: returns `{ok:true, payment}` when a valid, verified payment is present,
 * else `{ok:false, response}` (a 402 to return directly). Pass `opts.facilitator`
 * to inject a facilitator (tests).
 */
export async function requirePrivateX402(
  request: Request,
  config: SellerConfig | Seller,
  opts?: { facilitator?: FacilitatorLike; discovery?: Record<string, unknown> },
): Promise<GateResult> {
  const seller = toSeller(config);
  const resourceUrl = request.url;
  const requirements = sellerRequirements(seller);
  const ext = opts?.discovery;

  const header = request.headers.get("x-payment") ?? request.headers.get("payment-signature");
  if (!header) return { ok: false, response: paymentRequiredResponse(seller, resourceUrl, undefined, ext) };

  let wire: ReturnType<typeof decodeXPayment>;
  try {
    wire = decodeXPayment(header);
  } catch {
    return { ok: false, response: paymentRequiredResponse(seller, resourceUrl, "Malformed X-PAYMENT header", ext) };
  }

  const auth = wire.payload?.authorization;
  if (!auth || !wire.payload?.signature) {
    return { ok: false, response: paymentRequiredResponse(seller, resourceUrl, "X-PAYMENT missing signature/authorization", ext) };
  }
  // Bind the payment to THIS seller's price + wallet before trusting the facilitator.
  if ((auth.to ?? "").toLowerCase() !== seller.payTo.toLowerCase()) {
    return { ok: false, response: paymentRequiredResponse(seller, resourceUrl, "Payment recipient does not match this resource", ext) };
  }
  if (auth.value !== seller.priceAtomic) {
    return { ok: false, response: paymentRequiredResponse(seller, resourceUrl, "Payment amount does not match this resource's price", ext) };
  }

  // Map the wire payload into @x402/core's V2 PaymentPayload (seller supplies `accepted`).
  const paymentPayload: PaymentPayload = {
    x402Version: wire.x402Version ?? 2,
    accepted: requirements,
    payload: wire.payload as Record<string, unknown>,
  };

  const facilitator = opts?.facilitator ?? facilitatorFor(seller);
  try {
    const verified = await facilitator.verify(paymentPayload, requirements);
    if (!verified.isValid) {
      return {
        ok: false,
        response: paymentRequiredResponse(seller, resourceUrl, verified.invalidMessage ?? verified.invalidReason ?? "Payment invalid", ext),
      };
    }
    return { ok: true, payment: { paymentPayload, requirements, payer: verified.payer, facilitator, seller } };
  } catch (error) {
    return {
      ok: false,
      response: paymentRequiredResponse(seller, resourceUrl, `Payment verification unavailable: ${(error as Error).message.slice(0, 200)}`, ext),
    };
  }
}

/** Broadcast the settlement (funds → seller payTo). Call AFTER the handler succeeds. */
export async function settlePrivateX402(payment: VerifiedPrivatePayment): Promise<SettleResponse> {
  const settlement = await payment.facilitator.settle(payment.paymentPayload, payment.requirements);
  if (!settlement.success) {
    throw new Error(settlement.errorMessage ?? settlement.errorReason ?? "Settlement failed");
  }
  return settlement;
}

/**
 * Route wrapper — a seller gates their endpoint in one line:
 *
 *   export const GET = withPrivateX402(
 *     async (req, payment) => NextResponse.json(await getData()),
 *     { payTo: MY_WALLET, priceAtomic: "10000", network: "eip155:8453" },
 *   );
 *
 * On success it settles AFTER the handler returns <400 (so buyers aren't charged
 * for errors), attaching the PAYMENT-RESPONSE header. Funds land in `payTo`.
 */
export function withPrivateX402(
  handler: (request: Request, payment: VerifiedPrivatePayment) => Promise<Response> | Response,
  config: SellerConfig | Seller,
  opts?: { facilitator?: FacilitatorLike; discovery?: Record<string, unknown> },
): (request: Request) => Promise<Response> {
  return async (request: Request) => {
    const gate = await requirePrivateX402(request, config, opts);
    if (!gate.ok) return gate.response;

    const res = await handler(request, gate.payment);
    if (res.status < 400) {
      try {
        const settlement = await settlePrivateX402(gate.payment);
        const out = new NextResponse(res.body, res);
        out.headers.set("PAYMENT-RESPONSE", encodePaymentResponseHeader(settlement));
        return out;
      } catch (error) {
        return paymentRequiredResponse(gate.payment.seller, request.url, `Settlement failed: ${(error as Error).message.slice(0, 200)}`);
      }
    }
    return res;
  };
}
