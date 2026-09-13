/**
 * Mock integration: the BUYER SDK (`payAndFetch`) buys from a SELLER route gated
 * by `withPrivateX402`, end to end, with a mock facilitator (no chain, no CDP).
 * Proves: 402 → private settle → retry with X-PAYMENT → seller verifies + settles
 * to ITS payTo → handler runs → buyer gets data. Also that settlement targets the
 * seller's wallet and the buyer stays a fresh EOA.
 *
 *   npx tsx src/lib/private-x402-seller.test.ts
 */
import * as assert from "node:assert/strict";
import { NextResponse } from "next/server";
import { createFacilitatorClient } from "@zbase-protocol/core";
import { withPrivateX402, type FacilitatorLike } from "./private-x402-seller.js";

const BUYER_FACILITATOR = "https://facilitator.test";
const PROVIDER = "https://api.seller.test/api/data";
const NETWORK = "eip155:8453";
const SELLER_WALLET = "0xBf6926870E679DB20220Ac40F975Eb8925dFafff";
const PRICE = "10000";
const BUYER_EOA = "0x1111111111111111111111111111111111111111";

const DEPOSIT = { nullifier: "1", secret: "2", value: "990000", label: "3", commitment: "4" };
const CHANGE = { nullifier: "5", secret: "6", value: "980000", label: "3", commitment: "7" };
const DATA = { topTraded: ["TSLAx", "NVDAx"] };

let settledPayTo: string | null = null;
let settledAmount: string | null = null;

// Mock facilitator the SELLER uses (stands in for CDP / zBase). Records what it settled.
const mockFacilitator: FacilitatorLike = {
  verify: async (_p, req) => ({ isValid: true, payer: BUYER_EOA }),
  settle: async (_p, req) => {
    settledPayTo = req.payTo;
    settledAmount = req.amount;
    return { success: true, transaction: "0xsettle", network: req.network as `${string}:${string}`, payer: BUYER_EOA };
  },
};

// The seller's gated endpoint.
const gated = withPrivateX402(
  async () => NextResponse.json(DATA),
  { payTo: SELLER_WALLET, priceAtomic: PRICE, network: NETWORK, description: "RWA screener" },
  { facilitator: mockFacilitator },
);

// Buyer's mock fetch: routes to the seller handler for the provider URL, and
// fakes the buyer's own settle-x402 (produces an X-PAYMENT to the seller payTo).
let sawXPayment = false;
const buyerFetch: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input.toString();

  if (url === `${BUYER_FACILITATOR}/api/facilitator/settle-x402`) {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const a = body.accepts;
    const xPayment = Buffer.from(JSON.stringify({
      x402Version: 2,
      scheme: "exact",
      network: a.network,
      payload: {
        signature: "0x" + "11".repeat(65),
        authorization: {
          from: BUYER_EOA,
          to: a.payTo,
          value: a.amount ?? a.maxAmountRequired,
          validAfter: "0",
          validBefore: "9999999999",
          nonce: "0x" + "22".repeat(32),
        },
      },
    })).toString("base64");
    return jsonResponse(200, { settled: true, xPayment, payer: BUYER_EOA, amount: a.amount, fundingTxHash: "0xfund", nextDeposit: CHANGE });
  }

  if (url === PROVIDER) {
    const headers = new Headers(init?.headers);
    if (headers.get("x-payment")) sawXPayment = true;
    return gated(new Request(url, { method: init?.method ?? "GET", headers, body: init?.body as BodyInit | undefined }));
  }

  throw new Error(`unexpected fetch: ${url}`);
}) as typeof fetch;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function main() {
  const buyer = createFacilitatorClient({ baseUrl: BUYER_FACILITATOR, network: NETWORK, fetchImpl: buyerFetch });

  const r = await buyer.payAndFetch(PROVIDER, { method: "POST", body: JSON.stringify({ q: "rwa" }) }, { deposit: DEPOSIT, maxAmountAtomic: 50000n });

  assert.equal(r.paid, true, "buyer paid");
  assert.equal(r.status, 200, "seller served data after payment");
  assert.deepEqual(r.response, DATA, "buyer received the seller's data");
  assert.equal(sawXPayment, true, "seller was retried with an X-PAYMENT header");
  assert.equal(settledPayTo?.toLowerCase(), SELLER_WALLET.toLowerCase(), "settlement targeted the seller's existing wallet");
  assert.equal(settledAmount, PRICE, "settlement was for the seller's price");
  assert.deepEqual(r.nextDeposit, CHANGE, "buyer got a change note");

  // The seller rejects a mismatched price/recipient before hitting the facilitator.
  const wrong = withPrivateX402(async () => NextResponse.json(DATA), { payTo: SELLER_WALLET, priceAtomic: "99999", network: NETWORK }, { facilitator: mockFacilitator });
  const badXP = Buffer.from(JSON.stringify({ x402Version: 2, scheme: "exact", network: NETWORK, payload: { signature: "0x" + "11".repeat(65), authorization: { from: BUYER_EOA, to: SELLER_WALLET, value: PRICE, validAfter: "0", validBefore: "9999999999", nonce: "0x" + "22".repeat(32) } } })).toString("base64");
  const rej = await wrong(new Request(PROVIDER, { headers: { "x-payment": badXP } }));
  assert.equal(rej.status, 402, "price mismatch is rejected with 402");

  console.log("✓ private-x402-seller: buyer payAndFetch → withPrivateX402 gate → verify+settle to seller wallet → data; price/recipient binding enforced");
}

main().catch((e) => {
  console.error("✗ test failed:", e);
  process.exit(1);
});
