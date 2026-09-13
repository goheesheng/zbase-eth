/**
 * test-spend-guard.ts — you cannot spend a note in a way that loses the change.
 *
 * The 0.985 loss was a note spent with no recovery path. This asserts the guard closes
 * that on EVERY entry point: with neither a recoverable lineage nor an onNoteRotate, the
 * spend is REFUSED before anything leaves the wallet. And it asserts createPrivateFetch
 * now persists FIRST and AWAITS (a throwing async save fails the payment, note unspent),
 * matching the two adapters.
 *
 * Mock fetch throughout — no server, no chain, no funds.
 *
 * Run: npx tsx scripts/test-spend-guard.ts
 */
import {
  createFacilitatorClient,
  createZBaseExactClient,
  createZBasePrivateAccount,
  assertChangeRecoverable,
  isNoteRecoverable,
} from "../packages/core/src/index.ts";

let failed = false;
const ok = (m: string) => console.log("  PASS: " + m);
const bad = (m: string) => { console.log("  FAIL: " + m); failed = true; };

console.log("spend guard — no note spends without a recovery path\n");

const RANDOM = { nullifier: "1", secret: "2", value: "990000", label: "3", commitment: "4" }; // no index
const SEEDED = { ...RANDOM, index: 0 }; // recoverable lineage
const HEADER = Buffer.from(JSON.stringify({ x402Version: 2, payload: { signature: "0xsig", authorization: {} } })).toString("base64");
const REQS = { scheme: "exact", network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: "5000", payTo: "0xDbAA23601A95a01ee9B90160F6aA784CBE4E0f21", maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } };

// 0. The predicate + helper directly.
{
  isNoteRecoverable(SEEDED) === true ? ok("isNoteRecoverable: seed-derived deposit (index) => true") : bad("seeded not recoverable");
  isNoteRecoverable({ ...RANDOM, recoverable: true }) === true ? ok("isNoteRecoverable: propagated flag => true") : bad("flag ignored");
  isNoteRecoverable(RANDOM) === false ? ok("isNoteRecoverable: random note => false") : bad("random wrongly recoverable");

  let threw = false;
  try { assertChangeRecoverable(RANDOM, { hasPersist: false }); } catch { threw = true; }
  threw ? ok("assertChangeRecoverable throws on a random note with no persist") : bad("guard did not throw");
  let ok2 = true;
  try { assertChangeRecoverable(RANDOM, { hasPersist: true }); assertChangeRecoverable(RANDOM, { hasPersist: false, unsafe: true }); assertChangeRecoverable(SEEDED, { hasPersist: false }); } catch { ok2 = false; }
  ok2 ? ok("...and permits: persist OR unsafe OR recoverable lineage") : bad("guard over-refused");
}

/** A mock that answers /supported (ready) and settle/withdraw, tracking whether it spent. */
function mockClientFetch() {
  const state = { spent: false };
  const impl = (async (u: any, init: any) => {
    const url = String(u);
    if (url.includes("/supported")) return { json: async () => ({ customerReady: true }) } as any;
    if (url.includes("settle-x402") || url.includes("/api/withdraw")) {
      state.spent = true;
      const b = JSON.parse(init.body);
      const nd = { nullifier: b.nextNullifier ?? "9", secret: b.nextSecret ?? "9", value: "985000", label: "3", commitment: "7" };
      return { ok: true, status: 200, json: async () => ({ settled: true, xPayment: HEADER, nextDeposit: nd }) } as any;
    }
    // The seller. `payAndFetch` free-probes before settling (facilitatorClient #dummyProbe), so
    // this mock must behave like a REAL x402 verifier: reject the probe's deliberately-invalid
    // all-zero signature with 402 + a verifier-error body, and deliver only for the real signed
    // header returned by settle-x402. Answering 200 to the dummy means the seller never verified
    // anything, so the hardened client fails closed and refuses — which is correct behaviour, but
    // made 4 assertions below red for the wrong reason (2026-08-03).
    const headers = new Headers(init?.headers);
    const paymentRequired = new Headers({ "payment-required": Buffer.from(JSON.stringify({ x402Version: 2, accepts: [REQS] })).toString("base64") });
    const payment = headers.get("x-payment");
    if (payment) {
      if (payment !== HEADER) {
        return { status: 402, headers: paymentRequired, json: async () => ({ error: "invalid signature" }), text: async () => '{"error":"invalid signature"}' } as any;
      }
      return { status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ ok: true }), text: async () => '{"ok":true}' } as any;
    }
    return { status: 402, headers: paymentRequired, json: async () => ({}), text: async () => "{}" } as any;
  }) as typeof fetch;
  return { impl, state };
}

// 1. payAndFetch — refuses a random note with no onNoteRotate, before spending.
{
  const { impl, state } = mockClientFetch();
  const z = createFacilitatorClient({ baseUrl: "https://zbase.app", network: "eip155:8453", fetchImpl: impl });
  try {
    await z.payAndFetch("https://api.seller.ai/x", {}, { deposit: RANDOM });
    bad("payAndFetch spent a random note with no recovery path");
  } catch (e) {
    /would not be recoverable/.test((e as Error).message) ? ok("payAndFetch: random + no onNoteRotate => REFUSED") : bad("wrong error: " + (e as Error).message);
    state.spent === false ? ok("...nothing spent (refused before the settle)") : bad("spent despite refusal");
  }
  // ...but a seed-derived note is allowed.
  const m2 = mockClientFetch();
  const z2 = createFacilitatorClient({ baseUrl: "https://zbase.app", network: "eip155:8453", fetchImpl: m2.impl });
  const r = await z2.payAndFetch("https://api.seller.ai/x", {}, { deposit: SEEDED });
  r.paid ? ok("payAndFetch: a seed-derived note is allowed") : bad("seeded note refused");
  // ...and a random note WITH onNoteRotate is allowed, persisted.
  const m3 = mockClientFetch();
  const z3 = createFacilitatorClient({ baseUrl: "https://zbase.app", network: "eip155:8453", fetchImpl: m3.impl });
  let saved: any = null;
  await z3.payAndFetch("https://api.seller.ai/x", {}, { deposit: RANDOM, onNoteRotate: (n) => { saved = n; } });
  saved ? ok("payAndFetch: random + onNoteRotate => allowed, change persisted") : bad("onNoteRotate not called");
  // ...and the unsafe escape hatch.
  const m4 = mockClientFetch();
  const z4 = createFacilitatorClient({ baseUrl: "https://zbase.app", network: "eip155:8453", fetchImpl: m4.impl });
  const r4 = await z4.payAndFetch("https://api.seller.ai/x", {}, { deposit: RANDOM, unsafeAllowUnrecoverableChange: true });
  r4.paid ? ok("payAndFetch: unsafeAllowUnrecoverableChange overrides the guard") : bad("unsafe override failed");
}

// 2. createPrivateFetch — the persist is awaited, but a throwing save must NOT fail a SETTLED buy.
//    This assertion used to demand the opposite ("a throwing save FAILS the buy"). That contract was
//    deliberately reversed in payAndFetch: by the time onNoteRotate runs the note is ALREADY SPENT,
//    so throwing would report the payment as failed and invite the caller to pay again from another
//    note — a real double-spend — to protect a change note that is parent-key recoverable from the
//    seed anyway. A lost save costs a re-derive, not funds. Corrected 2026-08-03.
{
  const { impl } = mockClientFetch();
  const z = createFacilitatorClient({ baseUrl: "https://zbase.app", network: "eip155:8453", fetchImpl: impl });
  const buy = z.createPrivateFetch({
    deposit: SEEDED,
    onNoteRotate: async () => { throw new Error("disk full"); },
  });
  try {
    const r = await buy("https://api.seller.ai/x");
    r.paid ? ok("createPrivateFetch: a throwing onNoteRotate does NOT fail a settled buy (no double-spend bait)") : bad("settled buy reported unpaid");
    r.nextDeposit ? ok("...and the change note is still returned so the caller can re-persist it") : bad("change note dropped after a failed save");
  } catch (e) {
    bad("a throwing onNoteRotate propagated after settlement: " + (e as Error).message);
  }
}

// 3. The @x402/core adapter — refuses a random note with no persistence.
{
  const { impl, state } = mockClientFetch();
  const c = createZBaseExactClient({ deposit: RANDOM, baseUrl: "https://zbase.app", fetchImpl: impl, acceptNotPrivate: true });
  try {
    await c.createPaymentPayload(2, REQS as any);
    bad("scheme client spent a random note with no recovery path");
  } catch (e) {
    /would not be recoverable/.test((e as Error).message) ? ok("ZBaseExactClient: random + no onNoteRotate => REFUSED") : bad("wrong error");
    state.spent === false ? ok("...nothing spent") : bad("spent despite refusal");
  }
}

// 4. The viem LocalAccount adapter — refuses a random note with no persistence.
{
  const { impl, state } = mockClientFetch();
  const a = createZBasePrivateAccount({ deposit: RANDOM, baseUrl: "https://zbase.app", fetchImpl: impl });
  try {
    await a.signTypedData({
      domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: REQS.asset },
      types: { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
      primaryType: "TransferWithAuthorization",
      message: { from: a.address, to: REQS.payTo, value: 5000n, validAfter: 0n, validBefore: 9999999999n, nonce: ("0x" + "ab".repeat(32)) as `0x${string}` },
    });
    bad("account adapter spent a random note with no recovery path");
  } catch (e) {
    /would not be recoverable/.test((e as Error).message) ? ok("ZBasePrivateAccount: random + no onNoteRotate => REFUSED") : bad("wrong error: " + (e as Error).message);
    state.spent === false ? ok("...nothing withdrawn") : bad("withdrew despite refusal");
  }
}

console.log(failed ? "\nFAILED" : "\nSPEND GUARD: no entry point can spend into an unrecoverable change");
process.exit(failed ? 1 : 0);
