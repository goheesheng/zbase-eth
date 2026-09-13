/**
 * Chainalysis (L3 graph-taint) switch test — proves that flipping
 * ASP_SCREENING_PROVIDER=chainalysis composes a paid-KYT gate ON TOP of the
 * OFAC+overlay floor, WITHOUT a real Chainalysis subscription.
 *
 * We stand up a local mock KYT endpoint and point CHAINALYSIS_SCREENING_URL at
 * it. This exercises the real code path in src/lib/ofac-screening.ts
 * (createConfiguredScreeningProvider → withChainalysisProvider → screenAddress),
 * so it demonstrates the "switch" is live code — production just needs the real
 * CHAINALYSIS_SCREENING_URL + CHAINALYSIS_API_KEY.
 *
 *   npx tsx scripts/test-chainalysis-screening.ts
 */

import * as assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { screenDeposits, type DepositedLog } from "../src/lib/asp-screening";
import { createConfiguredScreeningProvider } from "../src/lib/ofac-screening";

const L1_OFAC = "0x0330070fd38ec3bb94f58fa55d40368271e9e54a" as const; // caught by OFAC floor
const CLEAN_BUT_TAINTED = "0x3333333333333333333333333333333333333333" as const; // only KYT flags it
const CLEAN = "0x4444444444444444444444444444444444444444" as const;

function dep(depositor: `0x${string}`, label: bigint): DepositedLog {
  return {
    depositor,
    label,
    txHash: `0x${label.toString(16).padStart(64, "0")}` as `0x${string}`,
    blockNumber: label,
  };
}

// Mock KYT: high risk for the "tainted" address, low for everything else.
function startMockKyt(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let address = "";
        try {
          address = String(JSON.parse(body).address ?? "").toLowerCase();
        } catch {
          /* ignore */
        }
        const risk = address === CLEAN_BUT_TAINTED ? "high" : "low";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ risk }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}/screen` });
    });
  });
}

async function main(): Promise<void> {
  const { server, url } = await startMockKyt();
  try {
    process.env.ASP_SCREENING_PROVIDER = "chainalysis";
    process.env.CHAINALYSIS_SCREENING_URL = url;
    process.env.CHAINALYSIS_API_KEY = "test-key-not-a-real-secret";

    const { provider, source } = await createConfiguredScreeningProvider();
    assert.ok(source.endsWith("+chainalysis"), "source reflects the composed KYT layer");
    assert.ok(typeof provider.screenAddress === "function", "KYT provider exposes async screenAddress");

    const deposits: DepositedLog[] = [
      dep(CLEAN, 100n),
      dep(L1_OFAC, 200n), // rejected by the OFAC floor (no network call needed)
      dep(CLEAN_BUT_TAINTED, 300n), // OFAC-clean but KYT-tainted → rejected by L3
    ];

    const result = await screenDeposits(deposits, provider);

    assert.deepEqual(result.approvedLabels, [100n], "only the fully-clean deposit is approved");

    const byLabel = new Map(result.rejected.map((r) => [r.label, r.reasonCode]));
    assert.equal(byLabel.get("200"), "ofac-sdn-direct", "OFAC floor still catches SDN address");
    assert.equal(byLabel.get("300"), "chainalysis-risk", "KYT layer catches the graph-tainted address");

    console.log(
      `chainalysis switch ok — source=${source} approved=[${result.approvedLabels.join(
        ", ",
      )}] rejected=${result.rejected.map((r) => `${r.label}:${r.reasonCode}`).join(", ")}`,
    );
    console.log(
      "scripts/test-chainalysis-screening.ts: ASP_SCREENING_PROVIDER=chainalysis composes a live L3 gate on top of OFAC",
    );
  } finally {
    server.close();
    delete process.env.ASP_SCREENING_PROVIDER;
    delete process.env.CHAINALYSIS_SCREENING_URL;
    delete process.env.CHAINALYSIS_API_KEY;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
