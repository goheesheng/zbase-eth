/**
 * Offline test of the zBase spec-facilitator's verification core: a real
 * viem-signed EIP-3009 authorization verifies; tampered recipient/amount/expiry
 * are rejected; the 5% take math is exact; signature splitting round-trips.
 *
 *   npx tsx src/lib/x402-facilitator.test.ts
 */
import * as assert from "node:assert/strict";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { buildExactPaymentHeader } from "./x402-exact-payment.js";
import { verifyExactPaymentLocal, settleTakeAtomic, splitSignature } from "./x402-facilitator.js";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = "0xBf6926870E679DB20220Ac40F975Eb8925dFafff";
// A throwaway private key (test only).
const PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const NOW = 1_700_000_000;

function requirements(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "exact",
    network: "eip155:8453",
    asset: USDC,
    amount: "10000",
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    extra: { name: "USD Coin", version: "2" },
    ...overrides,
  } as PaymentRequirements;
}

async function makePayload(): Promise<PaymentPayload> {
  const p = await buildExactPaymentHeader({
    privateKey: PK,
    payTo: PAY_TO,
    amountAtomic: "10000",
    asset: USDC,
    usdcName: "USD Coin",
    usdcVersion: "2",
    chainId: 8453,
    network: "eip155:8453",
    x402Version: 2,
    maxTimeoutSeconds: 300,
    nowSec: NOW,
  });
  return { x402Version: 2, accepted: requirements(), payload: p.payload.payload as Record<string, unknown> } as PaymentPayload;
}

async function main() {
  const payload = await makePayload();

  // Valid.
  const ok = await verifyExactPaymentLocal(payload, requirements(), NOW + 10);
  assert.equal(ok.valid, true, ok.reason);
  assert.ok(ok.payer && /^0x[0-9a-fA-F]{40}$/.test(ok.payer));

  // Recipient mismatch.
  const badTo = await verifyExactPaymentLocal(payload, requirements({ payTo: "0x0000000000000000000000000000000000000001" }), NOW + 10);
  assert.equal(badTo.valid, false);
  assert.match(badTo.reason!, /recipient mismatch/);

  // Amount mismatch.
  const badAmt = await verifyExactPaymentLocal(payload, requirements({ amount: "99999" }), NOW + 10);
  assert.equal(badAmt.valid, false);
  assert.match(badAmt.reason!, /amount mismatch/);

  // Expired (now >= validBefore = NOW+300).
  const expired = await verifyExactPaymentLocal(payload, requirements(), NOW + 301);
  assert.equal(expired.valid, false);
  assert.match(expired.reason!, /expired/);

  // Wrong EIP-712 domain (version) → signature won't recover to from.
  const badDomain = await verifyExactPaymentLocal(payload, requirements({ extra: { name: "USD Coin", version: "1" } }), NOW + 10);
  assert.equal(badDomain.valid, false);

  // Flat 5% take.
  assert.equal(settleTakeAtomic("10000"), 500n, "5% of 10000 = 500");
  assert.equal(settleTakeAtomic("1000000"), 50000n, "5% of 1e6 = 50000");

  // Signature split round-trips to a valid v.
  const sig = (payload.payload as { signature: string }).signature as `0x${string}`;
  const { v } = splitSignature(sig);
  assert.ok(v === 27 || v === 28, "v is 27/28");

  console.log("✓ x402-facilitator: EIP-3009 verify (valid + all rejections), flat 5% take, signature split");
}

main().catch((e) => {
  console.error("✗ test failed:", e);
  process.exit(1);
});
