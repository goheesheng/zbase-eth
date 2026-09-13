/**
 * Worked example — pay for a real third-party x402 endpoint privately
 *                  through the zBase privacy pool.
 *
 * Target: SAN Foundation's `/x402/v1/agents` endpoint
 *         (https://gateway.sanfoundation.com/x402/v1/agents).
 * Cost:   $0.0001 USDC per call, on Base mainnet.
 *
 * What this demonstrates
 * ----------------------
 * Historical integration shape: any standard x402-priced endpoint becomes
 * private with a wrapper around the developer's `fetch` via the legacy local
 * SDK. The active public SDK surface is now `@zbase-protocol/core`.
 *
 *   import { ZX402 as ZBase } from "../sdk/dist/index.js"; // legacy local SDK
 *   const zbase = new ZBase({ rpcUrl, privateKey });
 *   const account = zbase.restoreAccount(process.env.ZBASE_ACCOUNT_JSON);
 *   const fetchPrivately = zbase.wrapFetch(account);
 *   const res = await fetchPrivately(SAN_ENDPOINT);   // 402 → ZK proof → retry
 *
 * Honest failure mode (today)
 * ---------------------------
 * SAN settles on Base **mainnet**. zBase's privacy pool ships first on
 * Base **Sepolia** and is gated on the Base mainnet deploy/infra checklist. So
 * this script will:
 *
 *   1. SUCCEED at GET https://gateway.sanfoundation.com/x402/v1/agents
 *      — the real 402 response comes back, proving the call shape.
 *   2. FAIL at the zBase settlement step: the SDK is configured for
 *      Sepolia by default, and the on-chain pool we'd settle into
 *      doesn't yet exist on Base mainnet.
 *
 * The script prints SAN's 402 body in full, then prints the
 * settlement error with a pointer to STATUS.md. That output IS the
 * proof of integration shape until mainnet ships.
 *
 * After mainnet ships
 * -------------------
 * Reconcile this legacy SDK against the maintained `@zbase-protocol/core`
 * surface, configure the target facilitator for `eip155:8453`, and run the
 * same payment shape end-to-end.
 *
 * Running it now
 * --------------
 *   ZBASE_ACCOUNT_JSON='{"nullifier":"…","secret":"…","value":"…","label":"…","commitment":"…"}' \
 *   BASE_SEPOLIA_RPC=https://base-sepolia.infura.io/v3/YOUR_KEY \
 *   POSTMAN_PRIVATE_KEY=0x… \
 *   npx tsx scripts/x402-san-example.ts
 *
 * If you don't have a pre-funded zBase account JSON, run
 * `scripts/x402-test-agent.ts` once to mint one against the local
 * test server, then dump the resulting secrets to ZBASE_ACCOUNT_JSON.
 */

import "./load-env";

const SAN_ENDPOINT = "https://gateway.sanfoundation.com/x402/v1/agents";

function die(msg: string, exitCode = 1): never {
  console.error(`\n[x402-san-example] ${msg}`);
  process.exit(exitCode);
}

async function main() {
  console.log("=== zBase × SAN Foundation — worked x402 example ===\n");
  console.log(`target:   ${SAN_ENDPOINT}`);
  console.log(`network:  Base mainnet (eip155:8453)`);
  console.log(`zBase:    Base Sepolia today, mainnet pending — see STATUS.md\n`);

  // ----- Step 1: GET the SAN endpoint without payment. We expect a 402. -----
  console.log("[1/3] GET", SAN_ENDPOINT, "(no payment)");
  let firstRes: Response;
  try {
    firstRes = await fetch(SAN_ENDPOINT);
  } catch (err) {
    die(`Network error reaching SAN: ${(err as Error).message}`);
  }
  console.log(`      → status ${firstRes.status} ${firstRes.statusText}`);

  if (firstRes.status !== 402) {
    const body = await firstRes.text();
    die(
      `Expected 402 from SAN, got ${firstRes.status}. SAN may have changed pricing — body:\n${body.slice(0, 500)}`,
    );
  }

  // SAN puts the x402 challenge in a base64-encoded `payment-required`
  // HEADER, not in the body (the body is just `{}`). Decoding that header
  // is the actual demo: it shows the agent the on-chain `amount`,
  // `payTo`, `network`, and `asset` it needs to pay.
  console.log("\n[2/3] SAN's 402 challenge:");
  const paymentHeader = firstRes.headers.get("payment-required");
  if (paymentHeader) {
    try {
      const decoded = JSON.parse(Buffer.from(paymentHeader, "base64").toString("utf8"));
      console.log("  (from `payment-required` header, decoded)");
      console.log(JSON.stringify(decoded, null, 2));
    } catch {
      console.log("  (header present but base64 decode failed; raw):");
      console.log(paymentHeader);
    }
  } else {
    const challenge = await firstRes.json().catch(() => null);
    console.log("  (no payment-required header; falling back to body)");
    console.log(JSON.stringify(challenge, null, 2));
  }

  // ----- Step 2: try to settle privately via the zBase SDK. -----
  console.log("\n[3/3] Settling via zBase.wrapFetch() …");

  const accountJson = process.env.ZBASE_ACCOUNT_JSON || process.env.ZX402_ACCOUNT_JSON;
  if (!accountJson) {
    die(
      "ZBASE_ACCOUNT_JSON not set. This script intentionally requires a pre-funded\n" +
      "          zBase account so we don't deposit on every demo run. To produce one:\n" +
      "            1. run scripts/x402-test-agent.ts against the local test server\n" +
      "            2. copy the resulting secrets JSON into ZBASE_ACCOUNT_JSON",
      2,
    );
  }

  const rpcUrl = process.env.BASE_SEPOLIA_RPC;
  const privateKey = process.env.POSTMAN_PRIVATE_KEY;
  if (!rpcUrl || !privateKey) {
    die(
      "BASE_SEPOLIA_RPC and POSTMAN_PRIVATE_KEY are required. The SDK currently\n" +
      "          settles against Base Sepolia; settling against SAN's Base mainnet\n" +
      "          target is gated on the V1 mainnet deploy described in STATUS.md.",
      2,
    );
  }

  // Dynamic import keeps the script importable even if the SDK has not
  // been built yet (`packages/svm/sdk` is ESM, so we use import()).
  let ZBase;
  try {
    ({ ZX402: ZBase } = await import("../sdk/dist/index.js"));
  } catch (err) {
    die(
      `Failed to load SDK from ../sdk/dist/index.js: ${(err as Error).message}\n` +
      "          Run `npm run build` in the sdk/ directory first.",
    );
  }

  const zbase = new ZBase({
    rpcUrl,
    privateKey: privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`,
  });
  const account = zbase.restoreAccount(accountJson);

  // Wrap fetch and retry. The SDK does:
  //   1. issue the original request → 402
  //   2. extract `payTo` from the 402 body
  //   3. generate a Groth16 proof against the privacy pool
  //   4. submit a relay tx (the recipient sees "the pool paid me")
  //   5. retry with X-Payment-Tx header
  const fetchPrivately = zbase.wrapFetch(account);

  let final: Response;
  try {
    final = await fetchPrivately(SAN_ENDPOINT);
  } catch (err) {
    console.error("\n[x402-san-example] Settlement failed (this is the expected today-state):");
    console.error(`  ${(err as Error).message}`);
    console.error(
      "\n  Why: SAN settles on Base mainnet (eip155:8453); this SDK is currently\n" +
      "       configured for Base Sepolia (eip155:84532). zBase mainnet deploy is\n" +
      "       gated on the Base mainnet deploy/infra checklist. The 402 body\n" +
      "       above is the integration-shape proof we wanted from this run.",
    );
    process.exit(0); // not a script failure — the failure is data
  }

  // If we got here, mainnet support has shipped. Print the result.
  console.log(`      → status ${final.status} ${final.statusText}`);
  const data = await final.json().catch(() => null);
  console.log("\nSAN response:");
  console.log(JSON.stringify(data, null, 2));
  console.log(
    "\n[x402-san-example] Success. The provider sees the privacy pool paid them;\n" +
    "                   no link to the agent's wallet appears on-chain.",
  );
}

main().catch((err) => die(`unexpected error: ${err.stack ?? err.message}`));
