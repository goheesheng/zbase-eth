/**
 * test-facilitator-client.ts — smoke test for the SDK facilitator client.
 * Verifies prepareDeposit produces a deterministic-shape secret/precommitment,
 * and that verifyPayment/settlePrivately build request bodies matching the
 * facilitator API contract (using a mock fetch — no server needed).
 *
 * Run: npx tsx scripts/test-facilitator-client.ts
 */

import {
  createFacilitatorClient,
  computePrecommitment,
} from "../packages/core/src/index.ts";

let failed = false;
const ok = (m: string) => console.log("  PASS: " + m);
const bad = (m: string) => { console.log("  FAIL: " + m); failed = true; };

console.log("facilitator client smoke test\n");

// Capture what the client POSTs.
let lastUrl = "";
let lastBody: Record<string, unknown> = {};
const mockFetch = (async (url: string, init?: RequestInit) => {
  lastUrl = String(url);
  lastBody = init?.body ? JSON.parse(String(init.body)) : {};
  // Return a settle-shaped success so the client parses it.
  return {
    json: async () => ({ settled: true, txHash: "0xabc", network: "eip155:84532", valid: true }),
  } as Response;
}) as unknown as typeof fetch;

const client = createFacilitatorClient({
  baseUrl: "https://example.test/",
  network: "eip155:84532",
  fetchImpl: mockFetch,
});

// 1. prepareDeposit: precommitment must equal computePrecommitment(secrets).
{
  const dep = client.prepareDeposit(1_000_000n);
  if (dep.amountAtomic === "1000000") ok("prepareDeposit carries amount");
  else bad("prepareDeposit amount wrong: " + dep.amountAtomic);

  const expected = computePrecommitment(dep.secrets.nullifier, dep.secrets.secret);
  if (dep.precommitment === expected) ok("precommitment == computePrecommitment(secrets) (circuit-consistent)");
  else bad("precommitment mismatch");

  // Two calls → distinct secrets (randomness).
  const dep2 = client.prepareDeposit(1n);
  if (dep.secrets.nullifier !== dep2.secrets.nullifier) ok("secrets are fresh per deposit");
  else bad("secrets repeated across deposits");
}

// 2. verifyPayment: body matches the verify API contract.
{
  await client.verifyPayment({ payTo: "0xRecipient", amountAtomic: "700000" });
  if (lastUrl.endsWith("/api/facilitator/verify")) ok("verify hits /api/facilitator/verify");
  else bad("verify wrong url: " + lastUrl);
  const pd = (lastBody.paymentDetails ?? {}) as Record<string, unknown>;
  if (pd.scheme === "exact" && pd.networkId === "eip155:84532" && pd.payTo === "0xRecipient" && pd.maxAmountRequired === "700000")
    ok("verify body matches contract (scheme/networkId/payTo/maxAmountRequired)");
  else bad("verify body wrong: " + JSON.stringify(pd));
}

// 3. settlePrivately: body carries paymentDetails + zbaseDeposit.
{
  const deposit = {
    nullifier: "111", secret: "222", value: "700000", label: "333", commitment: "444",
  };
  const r = await client.settlePrivately({ payTo: "0xProvider", amountAtomic: "700000", deposit });
  if (lastUrl.endsWith("/api/facilitator/settle")) ok("settle hits /api/facilitator/settle");
  else bad("settle wrong url: " + lastUrl);
  const dep = (lastBody.zbaseDeposit ?? {}) as Record<string, unknown>;
  if (dep.nullifier === "111" && dep.commitment === "444") ok("settle body carries zbaseDeposit secrets");
  else bad("settle deposit body wrong: " + JSON.stringify(dep));
  const pd = (lastBody.paymentDetails ?? {}) as Record<string, unknown>;
  if (pd.payTo === "0xProvider" && pd.networkId === "eip155:84532") ok("settle paymentDetails correct");
  else bad("settle paymentDetails wrong");
  if (r.settled === true && r.txHash === "0xabc") ok("settle parses the success result");
  else bad("settle result parse wrong");
}

// 4. network override flows through.
{
  const mainnetClient = createFacilitatorClient({ baseUrl: "https://x.test", network: "eip155:8453", fetchImpl: mockFetch });
  await mainnetClient.verifyPayment({ payTo: "0xA", amountAtomic: "1" });
  const pd = (lastBody.paymentDetails ?? {}) as Record<string, unknown>;
  if (pd.networkId === "eip155:8453") ok("network override (mainnet) flows into requests");
  else bad("network override ignored");
}

console.log("");
if (failed) { console.log("FACILITATOR CLIENT: FAILED"); process.exit(1); }
console.log("FACILITATOR CLIENT: all checks passed");
