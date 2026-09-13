import assert from "node:assert/strict";
import { HTTPFacilitatorClient } from "@x402/core/http";
import { buildX402SupportedResponse } from "./x402-facilitator.js";

const BASE = "https://facilitator.example.test/api/facilitator/x402";
const NETWORK = "eip155:8453";

async function main() {
  const response = buildX402SupportedResponse(NETWORK);
  assert.deepEqual(response, {
    kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }],
    extensions: [],
    signers: {},
  });

  // Prove the response is accepted by the actual stock x402 v2 client rather
  // than merely resembling the documented JSON shape.
  const requests: Array<{ url: string; method: string }> = [];
  const client = new HTTPFacilitatorClient({ url: BASE });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    requests.push({ url, method: init?.method ?? "GET" });
    return Response.json(response);
  }) as typeof fetch;

  try {
    const supported = await client.getSupported();
    assert.deepEqual(supported, response);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(requests, [{ url: `${BASE}/supported`, method: "GET" }]);
  console.log("✓ x402 facilitator surface: /supported shape is accepted by HTTPFacilitatorClient");
}

main().catch((error) => {
  console.error("✗ x402 facilitator surface failed:", error);
  process.exit(1);
});
