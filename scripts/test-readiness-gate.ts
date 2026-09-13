/**
 * test-readiness-gate.ts — the SDK must refuse a facilitator that says it is closed.
 *
 * The contradiction this closes: /api/facilitator/supported honestly reports
 * customerReady:false with its blockingReasons, and settle-x402 is NOT readiness-gated
 * — so a payment against a closed facilitator SUCCEEDS. The buyer gets their data and
 * believes they paid privately. At an anonymity set below the launch minimum, the
 * withdrawal is linkable to the deposit, so they did not.
 *
 * The deployment was telling the truth and the SDK never asked. A privacy product
 * that is silently not private is worse than one that is honestly unavailable.
 *
 * Run: npx tsx scripts/test-readiness-gate.ts
 */
import * as assert from "node:assert/strict";
import { createFacilitatorClient, FacilitatorNotReadyError } from "../packages/core/src/index.ts";

let failed = false;
const ok = (m: string) => console.log("  PASS: " + m);
const bad = (m: string) => { console.log("  FAIL: " + m); failed = true; };

console.log("readiness gate — the SDK asks before it pays\n");

// index:0 ⇒ recoverable ⇒ passes the spend-guard; this suite tests the READINESS gate.
const NOTE = { nullifier: "1", secret: "2", value: "990000", label: "3", commitment: "4", index: 0 };
const REQS = {
  scheme: "exact", network: "eip155:8453",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  amount: "5000", payTo: "0xDbAA23601A95a01ee9B90160F6aA784CBE4E0f21",
  maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" },
};
const HEADER = Buffer.from(JSON.stringify({ x402Version: 2, payload: { signature: "0x", authorization: {} } })).toString("base64");

/** A facilitator + provider mock. `supported` drives the gate. */
function mockClient(supported: unknown) {
  const calls: string[] = [];
  const client = createFacilitatorClient({ baseUrl: "https://zbase.app", network: "eip155:8453" });
  (client as any).doFetch = async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push(url);
    if (url.includes("/supported")) return { json: async () => supported };
    if (url.includes("settle-x402")) return { json: async () => ({ settled: true, xPayment: HEADER }) };

    // The seller. `payAndFetch` free-probes before settling (facilitatorClient #dummyProbe), so
    // this mock must behave like a REAL CDP verifier or every payment is refused before it starts
    // and the readiness assertions below fail for the wrong reason (2026-08-03: that drift had
    // silently reddened 4 assertions). A probe carries X-PAYMENT with an invalid signature and is
    // only judged compatible on 402/400 + a verifier-error body (VERIFY_HINT).
    const hasPayment = Boolean(init?.headers?.["X-PAYMENT"]);
    const paymentRequired = new Headers({
      "payment-required": Buffer.from(JSON.stringify({ x402Version: 2, accepts: [REQS] })).toString("base64"),
    });
    if (hasPayment) {
      const isReal = init!.headers!["X-PAYMENT"] === HEADER;
      // The real settled header → deliver. The probe's dummy → reject like a real verifier.
      return isReal
        ? { status: 200, headers: new Headers(), json: async () => ({ ok: true }), text: async () => '{"ok":true}' }
        : {
            status: 402,
            headers: paymentRequired,
            json: async () => ({ error: "invalid signature" }),
            text: async () => '{"error":"invalid signature"}',
          };
    }
    // Unpaid first request → the 402 challenge.
    return { status: 402, headers: paymentRequired, json: async () => ({}), text: async () => "{}" };
  };
  return { client, calls };
}

// 1. THE POINT: a closed facilitator must refuse, not pay.
{
  const { client, calls } = mockClient({
    customerReady: false,
    blockingReasons: [
      // The REAL shape from /supported — {code,message,blocks}, not strings. A string
      // mock here is exactly what let "[object Object]" reach a live error message.
      { code: "ANONYMITY_SET_BELOW_MINIMUM", message: "The anonymity set is 2; customer use requires at least 30.", blocks: ["customer"] },
      { code: "ANONYMITY_SET_PROVENANCE_NOT_VERIFIED", blocks: ["customer"] },
    ],
    description: "closed for customer use",
  });
  await assert.rejects(
    () => client.payAndFetch("https://api.provider.ai/x", {}, { deposit: NOTE }),
    (e: Error) => e instanceof FacilitatorNotReadyError,
  );
  ok("customerReady:false => REFUSES to pay (was: paid silently, no privacy)");

  calls.some((u) => u.includes("settle-x402"))
    ? bad("it still called settle-x402 — the note would have been spent")
    : ok("never reached settle-x402 (the note is unspent)");
  calls.some((u) => u.includes("api.provider.ai"))
    ? bad("it hit the provider first — a closed facilitator should cost nothing")
    : ok("never hit the provider (checked BEFORE the 402 round-trip)");
}

// 2. The error must carry the facilitator's OWN reasons — a caller cannot act on
//    "not ready", but can act on "anonymity set below minimum".
{
  const { client } = mockClient({ customerReady: false, blockingReasons: [{ code: "ANONYMITY_SET_BELOW_MINIMUM", message: "The anonymity set is 2; customer use requires at least 30.", blocks: ["customer"] }] });
  try {
    await client.payAndFetch("https://api.provider.ai/x", {}, { deposit: NOTE });
    bad("did not throw");
  } catch (e) {
    const err = e as FacilitatorNotReadyError;
    err.codes.includes("ANONYMITY_SET_BELOW_MINIMUM") ? ok("error exposes reason CODES for programmatic handling") : bad("no codes");
    /anonymity set is 2/.test(err.message) ? ok("message renders code + message, not [object Object]") : bad("message did not render the reason: " + err.message);
    !/\[object Object\]/.test(err.message) ? ok("no [object Object] in the message") : bad("[object Object] leaked into the error");
    /would SUCCEED but would not be private/.test(err.message)
      ? ok("error explains the danger (it works, it just isn't private)")
      : bad("message does not explain why this matters");
  }
}

// 3. allowUnready is the deliberate escape hatch — testing plumbing, not privacy.
{
  const { client, calls } = mockClient({ customerReady: false, blockingReasons: [{ code: "X" }] });
  const res = await client.payAndFetch("https://api.provider.ai/x", {}, { deposit: NOTE, allowUnready: true });
  res.paid ? ok("allowUnready:true proceeds") : bad("allowUnready did not proceed");
  calls.some((u) => u.includes("settle-x402")) ? ok("reaches settle-x402 when opted in") : bad("did not settle");
}

// 4. An OPEN facilitator is unaffected.
{
  const { client } = mockClient({ customerReady: true });
  const res = await client.payAndFetch("https://api.provider.ai/x", {}, { deposit: NOTE });
  res.paid ? ok("customerReady:true pays normally") : bad("open facilitator refused");
}

// 5. BACKWARD COMPAT: a deployment that predates the gate has no customerReady field.
//    Treating "no answer" as "closed" would brick every older facilitator.
{
  const { client } = mockClient({ x402Version: 2, supported: [] });
  const res = await client.payAndFetch("https://api.provider.ai/x", {}, { deposit: NOTE });
  res.paid ? ok("absent customerReady => assumed OPEN (old deployments keep working)") : bad("bricked an old deployment");
}

// 6. Cached: the gate is a launch state, not per-payment. Re-fetching it on every buy
//    would add a round-trip to the hot path for information that changes in days.
{
  const { client, calls } = mockClient({ customerReady: true });
  await client.payAndFetch("https://api.provider.ai/x", {}, { deposit: NOTE });
  await client.payAndFetch("https://api.provider.ai/y", {}, { deposit: NOTE });
  const n = calls.filter((u) => u.includes("/supported")).length;
  n === 1 ? ok("readiness fetched once and cached across payments") : bad(`fetched ${n} times`);
}

// 7. A string-shaped blockingReasons (an older/other deployment) must not crash.
{
  const { client } = mockClient({ customerReady: false, blockingReasons: ["LEGACY_STRING_REASON"] });
  try {
    await client.payAndFetch("https://api.provider.ai/x", {}, { deposit: NOTE });
    bad("did not throw");
  } catch (e) {
    const err = e as FacilitatorNotReadyError;
    err.codes.includes("LEGACY_STRING_REASON") && !/\[object Object\]/.test(err.message)
      ? ok("tolerates a string-shaped blockingReasons (normalized, no crash)")
      : bad("string reasons mishandled");
  }
}

console.log(failed ? "\nFAILED" : "\nREADINESS GATE: the SDK no longer pays a facilitator that says it is closed");
process.exit(failed ? 1 : 0);
