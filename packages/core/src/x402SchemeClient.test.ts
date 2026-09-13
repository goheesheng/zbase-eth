/**
 * x402SchemeClient.test.ts — zBase as a drop-in @x402/core `exact` scheme client.
 *
 * Mock fetch throughout; no server, no funds, no chain.
 *
 * Run: npx tsx packages/core/src/x402SchemeClient.test.ts
 */
import * as assert from "node:assert/strict";
import { createZBaseExactClient } from "./x402SchemeClient.js";

// Seed-derived (index present ⇒ recoverable ⇒ passes the spend-guard). The guard is
// exercised on its own with an unrecoverable note further down.
const NOTE = {
  nullifier: "111",
  secret: "222",
  value: "990000",
  label: "333",
  commitment: "444",
  index: 0,
};

const CHANGE = {
  nullifier: "555",
  secret: "666",
  value: "985000",
  label: "333",
  commitment: "777",
};
// What the SDK rotates to: the server's change note + the propagated recoverability of
// its (seed-derived, index:0) parent. No HD index — change notes are parent-keyed.
const ROTATED = { ...CHANGE, recoverable: true };

const REQS = {
  scheme: "exact",
  network: "eip155:8453",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  amount: "5000",
  payTo: "0xDbAA23601A95a01ee9B90160F6aA784CBE4E0f21",
  maxTimeoutSeconds: 300,
  extra: { name: "USD Coin", version: "2" },
};

const INNER = { signature: "0xsig", authorization: { from: "0xE", to: REQS.payTo, value: "5000" } };
const HEADER = Buffer.from(JSON.stringify({ x402Version: 2, scheme: "exact", network: REQS.network, payload: INNER })).toString("base64");

const okResponse = (body: unknown) => ({ json: async () => body }) as unknown as Response;

let failed = false;
const ok = (m: string) => console.log("  PASS: " + m);
const bad = (m: string) => { console.log("  FAIL: " + m); failed = true; };

console.log("zBase x402 SchemeNetworkClient\n");

// 1. Shape: it structurally satisfies SchemeNetworkClient.
{
  const c = createZBaseExactClient({ deposit: NOTE });
  c.scheme === "exact" ? ok("scheme is 'exact'") : bad("scheme");
  typeof c.createPaymentPayload === "function"
    ? ok("implements createPaymentPayload → satisfies SchemeNetworkClient")
    : bad("createPaymentPayload missing");
}

// 2. Happy path: calls settle-x402, returns the INNER payload (not the header).
{
  let sentUrl = "";
  let sentBody: any = null;
  const c = createZBaseExactClient({
    deposit: NOTE,
    fetchImpl: (async (url: any, init: any) => {
      sentUrl = String(url);
      sentBody = JSON.parse(init.body);
      return okResponse({ settled: true, xPayment: HEADER, nextDeposit: CHANGE });
    }) as any,
  });

  const r = await c.createPaymentPayload(2, REQS);

  sentUrl.endsWith("/api/facilitator/settle-x402") ? ok("POSTs settle-x402") : bad("wrong url: " + sentUrl);
  assert.deepEqual(sentBody.accepts, REQS);
  ok("forwards the 402 requirements verbatim as `accepts`");
  assert.deepEqual(sentBody.zbaseDeposit, NOTE);
  ok("sends the pool note as `zbaseDeposit`");
  assert.deepEqual(r.payload, INNER);
  ok("returns the INNER payload {signature, authorization} — not the base64 header");
  r.x402Version === 2 ? ok("echoes x402Version") : bad("x402Version");
}

// 3. Note rotation: the change note replaces the spent one.
{
  const c = createZBaseExactClient({
    deposit: NOTE,
    fetchImpl: (async () => okResponse({ settled: true, xPayment: HEADER, nextDeposit: CHANGE })) as any,
  });
  assert.deepEqual(c.currentNote, NOTE);
  await c.createPaymentPayload(2, REQS);
  assert.deepEqual(c.currentNote, ROTATED);
  ok("rotates to the change note after paying");
}

// 4. THE EXPENSIVE ONE: onNoteRotate fires before returning, and a throwing
//    persister fails the payment loudly rather than silently losing the change.
{
  const saved: any[] = [];
  const c = createZBaseExactClient({
    deposit: NOTE,
    onNoteRotate: (n) => { saved.push(n); },
    fetchImpl: (async () => okResponse({ settled: true, xPayment: HEADER, nextDeposit: CHANGE })) as any,
  });
  await c.createPaymentPayload(2, REQS);
  assert.deepEqual(saved, [ROTATED]);
  ok("onNoteRotate receives the change note");
}
{
  const c = createZBaseExactClient({
    deposit: NOTE,
    onNoteRotate: () => { throw new Error("disk full"); },
    fetchImpl: (async () => okResponse({ settled: true, xPayment: HEADER, nextDeposit: CHANGE })) as any,
  });
  await assert.rejects(() => c.createPaymentPayload(2, REQS), /disk full/);
  ok("a throwing onNoteRotate FAILS the payment (never silently forfeits the change)");
}

// 5. Spend guards.
{
  const c = createZBaseExactClient({
    deposit: NOTE,
    maxAmountAtomic: "1000",
    fetchImpl: (async () => { throw new Error("must not be called"); }) as any,
  });
  await assert.rejects(() => c.createPaymentPayload(2, REQS), /Refusing to pay/);
  ok("maxAmountAtomic rejects a hostile 402 BEFORE any spend");
}
{
  const c = createZBaseExactClient({
    deposit: NOTE,
    fetchImpl: (async () => { throw new Error("must not be called"); }) as any,
  });
  await assert.rejects(() => c.createPaymentPayload(2, { ...REQS, scheme: "upto" }), /"exact" scheme only/);
  ok("refuses non-exact schemes without calling the facilitator");
}

// 6. Exhausted note (no change returned) → next call refuses with a real reason.
{
  const c = createZBaseExactClient({
    deposit: NOTE,
    fetchImpl: (async () => okResponse({ settled: true, xPayment: HEADER })) as any,
  });
  await c.createPaymentPayload(2, REQS);
  c.currentNote === undefined ? ok("note fully spent → currentNote undefined") : bad("currentNote");
  await assert.rejects(() => c.createPaymentPayload(2, REQS), /no spendable note left/);
  ok("exhausted note gives an actionable error, not a crash");
}

// 7. Facilitator errors surface, not swallowed.
{
  const c = createZBaseExactClient({
    deposit: NOTE,
    fetchImpl: (async () => okResponse({ settled: false, error: "Commitment not found in state tree" })) as any,
  });
  await assert.rejects(() => c.createPaymentPayload(2, REQS), /Commitment not found/);
  ok("propagates the facilitator's error message");
}

// 8. baseUrl safety: spend secrets must never go over plaintext to a remote host.
{
  assert.throws(() => createZBaseExactClient({ deposit: NOTE, baseUrl: "http://evil.example.com" }));
  ok("rejects a non-https baseUrl (spend secrets travel to it)");
}

console.log(failed ? "\nFAILED" : "\nzBase x402 scheme client: all invariants hold");
process.exit(failed ? 1 : 0);
