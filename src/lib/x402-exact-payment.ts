/**
 * Standard x402 "exact" (EVM / EIP-3009) payment construction.
 *
 * WHY THIS EXISTS
 * ---------------
 * zBase's `/api/facilitator/settle` pays a provider by withdrawing from the pool
 * DIRECTLY to the provider's payTo and handing the caller a proprietary
 * `X-Payment-TxHash` proof. That only works with zBase-aware servers (our own
 * test server). A standard x402 provider (Nansen, anything using the CDP
 * facilitator) never sees zBase in its 402 — the SELLER picks the facilitator —
 * and it verifies a signed `X-PAYMENT` authorization, not an on-chain transfer.
 * See https://docs.x402.org/core-concepts/facilitator.
 *
 * THE FIX
 * -------
 * Produce a spec-standard `X-PAYMENT` header from pool funds:
 *   1. Derive a single-use payer EOA `E` deterministically from the note.
 *   2. Withdraw the exact payment amount from the pool to `E` (ZK, unlinkable to
 *      the depositor) — done by the caller via /api/withdraw.
 *   3. `E` signs an EIP-3009 `transferWithAuthorization(E -> payTo, amount)`.
 *   4. Encode it as the base64 `X-PAYMENT` header the provider's own facilitator
 *      verifies + broadcasts. No on-chain link back to the depositor.
 *
 * This module is the pure, offline-testable core (steps 1, 3, 4). Step 2 is the
 * existing withdraw route. See x402-exact-payment.test.ts.
 */
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, encodePacked, type Hex } from "viem";
import { randomBytes } from "node:crypto";

/** secp256k1 group order. Private keys must be in [1, n-1]. */
const SECP256K1_N =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/**
 * Deterministically derive the single-use payer EOA private key from the note
 * secrets + recipient. Because a note's nullifier is single-use on-chain, this
 * key is effectively single-use, and it is re-derivable — so if the process
 * dies after the withdraw-to-E but before signing, the funds sitting in `E` are
 * never stranded: re-run the settle, re-derive the same key, re-sign.
 *
 * The note secret is spend authority; hashing it here does not weaken it (a
 * one-way keccak) and `E` has no on-chain link to the depositor.
 */
export function deriveX402PayerKey(
  deposit: { secret: string | bigint; nullifier: string | bigint },
  payTo: string,
): Hex {
  const raw = BigInt(
    keccak256(
      encodePacked(
        ["string", "uint256", "uint256", "address"],
        [
          "zbase-x402-payer-v1",
          BigInt(deposit.secret),
          BigInt(deposit.nullifier),
          payTo as Hex,
        ],
      ),
    ),
  );
  // Reduce into [1, n-1] (reject the zero key).
  const k = (raw % (SECP256K1_N - 1n)) + 1n;
  return `0x${k.toString(16).padStart(64, "0")}` as Hex;
}

export interface ExactPaymentInput {
  /** Payer EOA private key (from deriveX402PayerKey). */
  privateKey: Hex;
  /** Provider's payTo (from its 402 `accepts` entry). */
  payTo: string;
  /** Atomic amount, decimal string, e.g. "10000" for $0.01 USDC. */
  amountAtomic: string;
  /** Token contract (USDC) — the 402 `accepts.asset`. Also the EIP-712 verifyingContract. */
  asset: string;
  /** EIP-712 domain name from the 402 `accepts.extra.name` (e.g. "USD Coin"). */
  usdcName: string;
  /** EIP-712 domain version from `accepts.extra.version` (e.g. "2"). */
  usdcVersion: string;
  /** Chain id (e.g. 8453). */
  chainId: number;
  /** CAIP-2 network string to echo back (e.g. "eip155:8453"). */
  network: string;
  /** x402 protocol version to echo back (e.g. 2). */
  x402Version: number;
  /** Provider's `accepts.maxTimeoutSeconds` (authorization validity window). */
  maxTimeoutSeconds: number;
  /** Current unix time (seconds). Injected for deterministic tests. */
  nowSec: number;
  /** Optional nonce override (tests). Defaults to a random 32-byte value. */
  nonce?: Hex;
}

export interface ExactPayment {
  /** base64 `X-PAYMENT` header value. */
  header: string;
  /** The decoded payment payload (for logging/inspection). */
  payload: {
    x402Version: number;
    scheme: "exact";
    network: string;
    payload: { signature: Hex; authorization: Record<string, string> };
  };
  /** The payer EOA address (== authorization.from). */
  from: string;
}

/**
 * EIP-712 typed-data shape for USDC's `transferWithAuthorization` (EIP-3009).
 * Stable across USDC deployments; the domain (name/version/chainId/contract)
 * comes from the provider's 402 so we sign for the exact token it expects.
 */
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

/**
 * Build the standard x402 `exact`-scheme payment: sign the EIP-3009
 * authorization with `E` and encode the `X-PAYMENT` header. Pure + offline.
 */
export async function buildExactPaymentHeader(
  input: ExactPaymentInput,
): Promise<ExactPayment> {
  const account = privateKeyToAccount(input.privateKey);
  const nonce =
    input.nonce ?? (`0x${Buffer.from(randomBytes(32)).toString("hex")}` as Hex);
  const validAfter = 0n;
  const validBefore = BigInt(input.nowSec + input.maxTimeoutSeconds);

  const domain = {
    name: input.usdcName,
    version: input.usdcVersion,
    chainId: input.chainId,
    verifyingContract: input.asset as Hex,
  } as const;

  const message = {
    from: account.address,
    to: input.payTo as Hex,
    value: BigInt(input.amountAtomic),
    validAfter,
    validBefore,
    nonce,
  } as const;

  const signature = await account.signTypedData({
    domain,
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message,
  });

  // x402 authorization fields are stringified scalars + hex nonce.
  const authorization = {
    from: account.address,
    to: input.payTo,
    value: input.amountAtomic,
    validAfter: validAfter.toString(),
    validBefore: validBefore.toString(),
    nonce,
  };

  // v2 payloads REQUIRE `accepted` — the PaymentRequirements the payer selected from
  // the 402. Coinbase's CDP facilitator (which BlockRun and most sellers verify through)
  // validates the payload against a discriminated union and rejects a version-2 payload
  // that omits it: "'paymentPayload' is invalid: must match one of [x402V2PaymentPayload,
  // x402V1PaymentPayload]. x402V2PaymentPayload requires 'accepted'". We echo the selected
  // requirements verbatim (per x402 spec specs/schemes/exact/scheme_exact_evm.md). For a
  // v1 seller we emit the v1 shape (no `accepted`).
  const accepted = {
    scheme: "exact" as const,
    network: input.network,
    amount: input.amountAtomic,
    asset: input.asset,
    payTo: input.payTo,
    maxTimeoutSeconds: input.maxTimeoutSeconds,
    extra: { name: input.usdcName, version: input.usdcVersion },
  };
  const payload = {
    x402Version: input.x402Version,
    scheme: "exact" as const,
    network: input.network,
    ...(input.x402Version >= 2 ? { accepted } : {}),
    payload: { signature, authorization },
  };

  const header = Buffer.from(JSON.stringify(payload)).toString("base64");
  return { header, payload, from: account.address };
}

/** Parse a CAIP-2 "eip155:8453" network string into a numeric chain id. */
export function chainIdFromCaip2(network: string): number {
  const m = /^eip155:(\d+)$/.exec(network.trim());
  if (!m) throw new Error(`Unsupported non-EVM x402 network: ${network}`);
  return Number(m[1]);
}
