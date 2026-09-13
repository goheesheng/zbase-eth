/**
 * Offline verification of the standard x402 "exact" payment builder.
 *
 *   npx tsx src/lib/x402-exact-payment.test.ts
 *
 * Proves the novel, security-critical part without touching a chain:
 *  1. deriveX402PayerKey is deterministic and yields a valid secp256k1 key.
 *  2. The signed EIP-3009 authorization RECOVERS to the payer EOA (a provider's
 *     facilitator will do exactly this recovery before broadcasting).
 *  3. The X-PAYMENT header base64-decodes to the correct x402 payload shape.
 */
import * as assert from "node:assert/strict";
import { recoverTypedDataAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  deriveX402PayerKey,
  buildExactPaymentHeader,
  chainIdFromCaip2,
} from "./x402-exact-payment.js";

// A sample note (decimal field-element strings, as the pool emits them).
const deposit = {
  secret: "12345678901234567890123456789012345678901234567890",
  nullifier: "98765432109876543210987654321098765432109876543210",
};
const PAY_TO = "0x93053f1e7A5eFEDa532Fe69CbbE43cBEc3A0F13f";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

async function main() {
  // 1. Deterministic + valid key.
  const k1 = deriveX402PayerKey(deposit, PAY_TO);
  const k2 = deriveX402PayerKey(deposit, PAY_TO);
  assert.equal(k1, k2, "key derivation must be deterministic (crash-recoverable)");
  assert.match(k1, /^0x[0-9a-f]{64}$/, "key must be 32-byte hex");
  const acct = privateKeyToAccount(k1);
  // Different recipient → different single-use key.
  assert.notEqual(
    deriveX402PayerKey(deposit, "0x0000000000000000000000000000000000000001"),
    k1,
    "key must be bound to payTo",
  );

  assert.equal(chainIdFromCaip2("eip155:8453"), 8453);
  assert.throws(() => chainIdFromCaip2("solana:mainnet"), /non-EVM/);

  // 2. Build + recover.
  const nowSec = 1_700_000_000;
  const nonce =
    "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex;
  const { header, payload, from } = await buildExactPaymentHeader({
    privateKey: k1,
    payTo: PAY_TO,
    amountAtomic: "10000",
    asset: USDC,
    usdcName: "USD Coin",
    usdcVersion: "2",
    chainId: 8453,
    network: "eip155:8453",
    x402Version: 2,
    maxTimeoutSeconds: 300,
    nowSec,
    nonce,
  });

  assert.equal(from, acct.address, "payload.from must be the derived EOA");

  const recovered = await recoverTypedDataAddress({
    domain: {
      name: "USD Coin",
      version: "2",
      chainId: 8453,
      verifyingContract: USDC as Hex,
    },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: {
      from: acct.address,
      to: PAY_TO as Hex,
      value: 10000n,
      validAfter: 0n,
      validBefore: BigInt(nowSec + 300),
      nonce,
    },
    signature: payload.payload.signature,
  });
  assert.equal(
    recovered.toLowerCase(),
    acct.address.toLowerCase(),
    "EIP-3009 signature must recover to the payer EOA (facilitator will verify this)",
  );

  // 3. Header shape.
  const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  assert.equal(decoded.x402Version, 2);
  assert.equal(decoded.scheme, "exact");
  assert.equal(decoded.network, "eip155:8453");
  assert.equal(decoded.payload.authorization.to.toLowerCase(), PAY_TO.toLowerCase());
  assert.equal(decoded.payload.authorization.value, "10000");
  assert.equal(decoded.payload.authorization.validBefore, String(nowSec + 300));
  assert.match(decoded.payload.signature, /^0x[0-9a-f]{130}$/);

  console.log("✓ x402-exact-payment: key derivation, EIP-3009 recovery, and header shape all verified");
}

main().catch((e) => {
  console.error("✗ test failed:", e);
  process.exit(1);
});
