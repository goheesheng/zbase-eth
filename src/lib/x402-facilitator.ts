/**
 * x402-facilitator.ts — zBase as a SPEC-COMPLIANT x402 facilitator for the
 * `exact` (EIP-3009) scheme, so a seller can point their `facilitatorUrl` at
 * zBase (routing the 5% take through us) instead of CDP.
 *
 * Split for testability:
 *   verifyExactPaymentLocal(...)  — PURE: recover the EIP-3009 signer + all the
 *                                   off-chain checks. Unit-tested, no chain.
 *   broadcastTransferWithAuthorization(...) — the on-chain settle (postman).
 *   settleTakeAtomic(...)         — the flat 5% take, recorded not enforced.
 *
 * The buyer's wire payload is `{ signature, authorization:{from,to,value,
 * validAfter,validBefore,nonce} }`; we reconstruct the USDC EIP-712 domain from
 * the requirements' `extra.{name,version}` + asset + chainId.
 */
import { recoverTypedDataAddress, parseSignature, type Hex } from "viem";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { chainIdFromCaip2 } from "@/lib/x402-exact-payment";

/** Flat take rate: 5% (500 bps) per settle, same for everyone. */
export const TAKE_BPS = 500n;

/**
 * Standard x402 v2 discovery response served from
 * `/api/facilitator/x402/supported`.
 *
 * This advertises the SELLER-facing facilitator capability only. It is
 * intentionally independent of the privacy pool's customer-readiness gate:
 * `/x402/verify` and `/x402/settle` verify and broadcast an authorization the
 * seller already holds and make no claim that the buyer used zBase upstream.
 */
export function buildX402SupportedResponse(network: string) {
  return {
    kinds: [
      {
        x402Version: 2,
        scheme: "exact",
        network,
      },
    ],
    extensions: [] as string[],
    // The exact EIP-3009 mechanism does not require a facilitator signer to be
    // advertised to clients. Keep the standard field present for strict v2
    // clients and add per-network signers only if a future extension needs one.
    signers: {} as Record<string, string[]>,
  };
}

const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export interface ExactAuthorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

export interface LocalVerifyResult {
  valid: boolean;
  payer?: string;
  reason?: string;
}

function extractExact(payload: PaymentPayload): { signature?: Hex; authorization?: ExactAuthorization } {
  const p = payload.payload as { signature?: string; authorization?: ExactAuthorization } | undefined;
  return { signature: p?.signature as Hex | undefined, authorization: p?.authorization };
}

/**
 * PURE off-chain verification of an `exact`/EIP-3009 payment against the seller's
 * requirements: recovers the signer and checks recipient, amount, scheme, and the
 * validity window. Does NOT check on-chain balance (the route does that before broadcast).
 */
export async function verifyExactPaymentLocal(
  paymentPayload: PaymentPayload,
  requirements: PaymentRequirements,
  nowSec: number,
): Promise<LocalVerifyResult> {
  if ((requirements.scheme ?? "exact") !== "exact") return { valid: false, reason: "unsupported scheme" };
  const { signature, authorization } = extractExact(paymentPayload);
  if (!signature || !authorization) return { valid: false, reason: "missing signature/authorization" };

  const name = (requirements.extra as { name?: string })?.name;
  const version = (requirements.extra as { version?: string })?.version;
  if (!name || !version) return { valid: false, reason: "requirements.extra.{name,version} required for EIP-712 domain" };

  let chainId: number;
  try {
    chainId = chainIdFromCaip2(requirements.network);
  } catch (e) {
    return { valid: false, reason: (e as Error).message };
  }

  // Recipient + amount must match what the seller asked for.
  if (authorization.to.toLowerCase() !== requirements.payTo.toLowerCase()) return { valid: false, reason: "recipient mismatch" };
  if (authorization.value !== requirements.amount) return { valid: false, reason: "amount mismatch" };

  // Validity window.
  const validAfter = BigInt(authorization.validAfter);
  const validBefore = BigInt(authorization.validBefore);
  const now = BigInt(Math.floor(nowSec));
  if (now < validAfter) return { valid: false, reason: "authorization not yet valid" };
  if (now >= validBefore) return { valid: false, reason: "authorization expired" };

  // Recover the signer over the exact USDC EIP-712 domain.
  let recovered: string;
  try {
    recovered = await recoverTypedDataAddress({
      domain: { name, version, chainId, verifyingContract: requirements.asset as Hex },
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: authorization.from as Hex,
        to: authorization.to as Hex,
        value: BigInt(authorization.value),
        validAfter,
        validBefore,
        nonce: authorization.nonce as Hex,
      },
      signature,
    });
  } catch (e) {
    return { valid: false, reason: `signature recovery failed: ${(e as Error).message}` };
  }
  if (recovered.toLowerCase() !== authorization.from.toLowerCase()) {
    return { valid: false, reason: "signature does not match authorization.from" };
  }

  return { valid: true, payer: authorization.from };
}

/** Flat 5% take (500 bps) for this settle — recorded, not enforced while FEE_REQUIRED=false. */
export function settleTakeAtomic(amountAtomic: string): bigint {
  return (BigInt(amountAtomic) * TAKE_BPS) / 10000n;
}

/** USDC EIP-3009 `transferWithAuthorization(from,to,value,validAfter,validBefore,nonce,v,r,s)`. */
export const USDC_TRANSFER_WITH_AUTHORIZATION_ABI = [
  {
    name: "transferWithAuthorization",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;

/** Split a 65-byte signature into the (v, r, s) the EIP-3009 call expects. */
export function splitSignature(signature: Hex): { v: number; r: Hex; s: Hex } {
  const sig = parseSignature(signature);
  // parseSignature yields yParity; USDC wants v ∈ {27,28}.
  const v = sig.v !== undefined ? Number(sig.v) : (sig.yParity ?? 0) + 27;
  return { v, r: sig.r, s: sig.s };
}
