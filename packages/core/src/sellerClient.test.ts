/**
 * Offline test: a seller gates their API and the 402 it emits is exactly what
 * the buyer SDK can pay. Proves createSeller validation + buildPaymentRequired
 * shape + USDC EIP-712 domain, and that selectExactAccepts picks the entry.
 *
 *   npx tsx packages/core/src/sellerClient.test.ts
 */
import * as assert from "node:assert/strict";
import { createSeller, buildPaymentRequired, DEFAULT_SELLER_FACILITATOR_URL } from "./sellerClient.js";
import { selectExactAccepts, type X402PaymentRequired } from "./facilitatorClient.js";

const PAY_TO = "0xBf6926870E679DB20220Ac40F975Eb8925dFafff";

async function main() {
  // Mainnet seller — canonical USDC domain.
  const seller = createSeller({ payTo: PAY_TO, priceAtomic: "10000", network: "eip155:8453", description: "RWA screener" });
  assert.equal(seller.asset.toLowerCase(), "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
  assert.equal(seller.tokenName, "USD Coin");
  assert.equal(seller.tokenVersion, "2");
  assert.equal(seller.maxTimeoutSeconds, 300);

  const pr = buildPaymentRequired(seller, { resourceUrl: "https://api.seller.test/x" });
  assert.equal(pr.x402Version, 2);
  assert.equal(pr.accepts.length, 1);
  const a = pr.accepts[0];
  assert.equal(a.scheme, "exact");
  assert.equal(a.network, "eip155:8453");
  assert.equal(a.amount, "10000");
  assert.equal(a.payTo, PAY_TO);
  assert.equal(a.extra.name, "USD Coin");
  assert.equal(a.extra.version, "2");

  // The buyer SDK must be able to select this entry (round-trip contract).
  const picked = selectExactAccepts(pr as unknown as X402PaymentRequired, "eip155:8453");
  assert.equal(picked.payTo, PAY_TO);
  assert.equal(picked.amount, "10000");

  // Defaults: mainnet + zBase facilitator (so devs get zBase with no config).
  assert.equal(seller.facilitatorUrl, DEFAULT_SELLER_FACILITATOR_URL, "seller defaults to zBase facilitator");
  const dflt = createSeller({ payTo: PAY_TO, priceAtomic: "5000" }); // no network → mainnet
  assert.equal(dflt.network, "eip155:8453", "default network is mainnet");
  assert.equal(dflt.asset.toLowerCase(), "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
  assert.equal(dflt.tokenName, "USD Coin");
  assert.equal(dflt.facilitatorUrl, DEFAULT_SELLER_FACILITATOR_URL);

  // Sepolia is still available explicitly — DIFFERENT USDC domain ("USDC").
  const testnet = createSeller({ payTo: PAY_TO, priceAtomic: "5000", network: "eip155:84532" });
  assert.equal(testnet.asset.toLowerCase(), "0x036cbd53842c5426634e7929541ec2318f3dcf7e");
  assert.equal(testnet.tokenName, "USDC");
  // Explicit CDP opt-out via empty facilitatorUrl.
  assert.equal(createSeller({ payTo: PAY_TO, priceAtomic: "1", facilitatorUrl: "" }).facilitatorUrl, "");

  // Validation.
  assert.throws(() => createSeller({ payTo: "not-an-address", priceAtomic: "1" }), /payTo must be a 0x/);
  assert.throws(() => createSeller({ payTo: PAY_TO, priceAtomic: "0" }), /positive integer/);
  assert.throws(() => createSeller({ payTo: PAY_TO, priceAtomic: "1", network: "solana:mainnet" as never }), /Unsupported network/);

  console.log("✓ sellerClient: createSeller validation + buildPaymentRequired shape + USDC domain + buyer can select the entry");
}

main().catch((e) => {
  console.error("✗ test failed:", e);
  process.exit(1);
});
