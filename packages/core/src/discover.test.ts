/**
 * discover() filters + normalizes the x402 bazaar so a buyer can hand a result
 * straight to payAndFetch. Mock bazaar, no network.
 *
 *   npx tsx packages/core/src/discover.test.ts
 */
import * as assert from "node:assert/strict";
import { createFacilitatorClient, DEFAULT_BAZAAR_DISCOVERY_URL } from "./facilitatorClient.js";

const BAZAAR = {
  items: [
    { resource: "https://api.nansen.ai/x/dex-trades", serviceName: "Nansen", description: "RWA and token screener", tags: ["rwa", "defi"], accepts: [{ scheme: "exact", network: "eip155:8453", amount: "10000", asset: "0xUSDC", payTo: "0xseller1", extra: { name: "USD Coin", version: "2" } }] },
    { resource: "https://api.weather.test/now", serviceName: "Weather", description: "current weather", tags: ["weather"], accepts: [{ scheme: "exact", network: "eip155:8453", maxAmountRequired: "2000", asset: "0xUSDC", recipient: "0xseller2" }] },
  ],
  pagination: { total: 2 },
};

const mockFetch: typeof fetch = (async (input: string | URL) => {
  const url = typeof input === "string" ? input : input.toString();
  assert.ok(url.startsWith(DEFAULT_BAZAAR_DISCOVERY_URL), "hits the bazaar discovery URL");
  return new Response(JSON.stringify(BAZAAR), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

async function main() {
  const c = createFacilitatorClient({ baseUrl: "https://zbase.app", network: "eip155:8453", fetchImpl: mockFetch });

  const all = await c.discover();
  assert.equal(all.length, 2, "no query returns everything");

  const rwa = await c.discover("rwa screener");
  assert.equal(rwa.length, 1, "multi-term filter is AND across name/desc/tags");
  assert.equal(rwa[0].serviceName, "Nansen");
  assert.equal(rwa[0].accepts[0].payTo, "0xseller1");
  assert.equal(rwa[0].accepts[0].amount, "10000");

  // Normalization: maxAmountRequired → amount, recipient → payTo.
  const w = await c.discover("weather");
  assert.equal(w[0].accepts[0].amount, "2000");
  assert.equal(w[0].accepts[0].payTo, "0xseller2");

  const none = await c.discover("nonexistent-term-xyz");
  assert.equal(none.length, 0);

  console.log("✓ discover: bazaar fetch + AND-term filter + normalize (amount/payTo); ready for payAndFetch");
}

main().catch((e) => { console.error("✗ test failed:", e); process.exit(1); });
