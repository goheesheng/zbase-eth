/**
 * The SDK defaults to zBase's facilitator on mainnet with ZERO config, so a
 * developer who just installs it gets the owner's facilitator by default.
 *
 *   npx tsx packages/core/src/defaults.test.ts
 */
import * as assert from "node:assert/strict";
import { createFacilitatorClient, DEFAULT_FACILITATOR_URL } from "./facilitatorClient.js";

async function main() {
  assert.equal(DEFAULT_FACILITATOR_URL, "https://zbase.app");

  // Capture where the client actually talks with NO config passed.
  const hits: string[] = [];
  const mockFetch: typeof fetch = (async (input: string | URL) => {
    hits.push(typeof input === "string" ? input : input.toString());
    // Minimal bazaar response so discover() completes.
    return new Response(JSON.stringify({ items: [], pagination: { total: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  // No args except the test fetch — must default to zbase.app + mainnet.
  const c = createFacilitatorClient({ fetchImpl: mockFetch });

  // supported() targets the default base host.
  await c.supported().catch(() => {});
  assert.ok(hits.some((u) => u.startsWith("https://zbase.app/api/facilitator/")), `expected zbase.app host, got ${hits.join(", ")}`);

  // A private buy would settle against the default host too — assert via the settle-x402 URL
  // the client would call. We drive payAndFetch against a mock provider that 402s, then the
  // client calls <base>/api/facilitator/settle-x402.
  hits.length = 0;
  const provider = "https://api.provider.test/x";
  const flowFetch: typeof fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    hits.push(url);
    if (url === provider) {
      // First hit → 402 with a mainnet accepts entry.
      const headers = new Headers(init?.headers);
      if (!headers.get("x-payment")) {
        return new Response(JSON.stringify({ x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: "10000", payTo: "0xabc", extra: { name: "USD Coin", version: "2" } }] }), { status: 402, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/api/facilitator/settle-x402")) {
      return new Response(JSON.stringify({ settled: true, xPayment: "eyJ4IjoxfQ==", payer: "0xE", amount: "10000" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error("unexpected " + url);
  }) as typeof fetch;

  const c2 = createFacilitatorClient({ fetchImpl: flowFetch });
  await c2.payAndFetch(provider, {}, { deposit: { nullifier: "1", secret: "2", value: "990000", label: "3", commitment: "4" }, maxAmountAtomic: "10000" });
  assert.ok(hits.includes("https://zbase.app/api/facilitator/settle-x402"), `settle went to the default zbase.app host; hits=${hits.join(", ")}`);

  console.log("✓ defaults: createFacilitatorClient() with no config → zbase.app + mainnet (supported + settle-x402 hit the default host)");
}

main().catch((e) => { console.error("✗ test failed:", e); process.exit(1); });
