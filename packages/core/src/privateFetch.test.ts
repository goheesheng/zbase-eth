/**
 * End-to-end (mocked) proof that an agent plugging in the SDK can buy from a
 * standard x402 provider PRIVATELY with one call. No chain, no network: a fake
 * fetch plays both the provider (402 then 200) and the facilitator (settle-x402).
 *
 *   npx tsx packages/core/src/privateFetch.test.ts
 */
import * as assert from "node:assert/strict";
import {
  createFacilitatorClient,
  parsePaymentRequired,
  selectExactAccepts,
  diagnoseSellerFacilitatorFault,
  type X402PaymentRequired,
} from "./facilitatorClient.js";

const FACILITATOR = "https://facilitator.test";
const PROVIDER = "https://api.provider.test/data";
const NETWORK = "eip155:8453";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const PAYMENT_REQUIRED = {
  x402Version: 2,
  error: "Payment required",
  accepts: [
    // A non-payable option (wrong network) to prove selection filters correctly.
    { scheme: "exact", network: "eip155:56", asset: "0xabc", amount: "10000", payTo: "0xdead", extra: { name: "x", version: "1" } },
    // The payable one.
    { scheme: "exact", network: NETWORK, asset: USDC, amount: "10000", payTo: "0x93053f1e7A5eFEDa532Fe69CbbE43cBEc3A0F13f", maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } },
  ],
};

// index:0 ⇒ recoverable ⇒ passes the spend-guard (change notes inherit it, no HD index).
const DEPOSIT = { nullifier: "1", secret: "2", value: "990000", label: "3", commitment: "4", index: 0 };
const CHANGE_NOTE = { nullifier: "5", secret: "6", value: "980000", label: "3", commitment: "7" };
const ROTATED = { ...CHANGE_NOTE, recoverable: true };
const PROVIDER_DATA = { topTraded: ["TSLAx", "NVDAx"], window: "7d" };

let sawXPaymentHeader: string | null = null;
let settleCalls = 0;

const mockFetch: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input.toString();
  const headers = new Headers(init?.headers);

  // Facilitator: private settle → hand back a (fake) X-PAYMENT header + change note.
  if (url === `${FACILITATOR}/api/facilitator/settle-x402`) {
    settleCalls++;
    const body = JSON.parse(String(init?.body ?? "{}"));
    assert.equal(body.accepts.network, NETWORK, "facilitator must be paid the payable entry");
    assert.ok(body.zbaseDeposit?.nullifier, "deposit secrets forwarded to facilitator");
    return jsonResponse(200, {
      settled: true,
      xPayment: "eyJmYWtlIjoicGF5bWVudCJ9",
      payer: "0x1111111111111111111111111111111111111111",
      amount: "10000",
      fundingTxHash: "0xfund",
      nextDeposit: CHANGE_NOTE,
    });
  }

  // Facilitator readiness check (payAndFetch asks before spending).
  if (url === `${FACILITATOR}/api/facilitator/supported`) {
    return jsonResponse(200, { customerReady: true });
  }

  // Provider: 402 without payment. The free-probe first sends an INVALID-signature dummy —
  // a real verifier rejects that with a 402 verify error (which is how the probe learns the
  // seller is compatible). Only the real settled header ("eyJmYWtl…") yields 200 + data.
  if (url === PROVIDER) {
    const xp = headers.get("x-payment") ?? headers.get("payment-signature");
    if (!xp) return jsonResponse(402, PAYMENT_REQUIRED);
    if (xp !== "eyJmYWtlIjoicGF5bWVudCJ9") {
      return jsonResponse(402, { error: "Facilitator verify failed: invalid signature: R is 0, isValid:false" });
    }
    sawXPaymentHeader = xp;
    return jsonResponse(200, PROVIDER_DATA);
  }

  throw new Error(`unexpected fetch: ${url}`);
}) as typeof fetch;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function main() {
  // Pure helpers.
  const pr = (await parsePaymentRequired(jsonResponse(402, PAYMENT_REQUIRED))) as X402PaymentRequired;
  assert.ok(pr && pr.accepts.length === 2);
  const entry = selectExactAccepts(pr, NETWORK, USDC);
  assert.equal(entry.network, NETWORK);
  assert.equal(entry.payTo, "0x93053f1e7A5eFEDa532Fe69CbbE43cBEc3A0F13f");
  assert.throws(
    () => selectExactAccepts({ accepts: [{ scheme: "exact", network: "eip155:1", asset: "0x", payTo: "0x", amount: "1" }] }, NETWORK),
    /No payable option/,
    "must reject when nothing matches the facilitator network",
  );

  const zbase = createFacilitatorClient({ baseUrl: FACILITATOR, network: NETWORK, fetchImpl: mockFetch });

  // One-call private buy.
  const r = await zbase.payAndFetch(
    PROVIDER,
    { method: "POST", body: JSON.stringify({ q: "rwa" }) },
    { deposit: DEPOSIT, maxAmountAtomic: 50000n },
  );
  assert.equal(r.paid, true, "should have paid");
  assert.equal(r.status, 200);
  assert.deepEqual(r.response, PROVIDER_DATA, "agent gets the provider data");
  assert.equal(sawXPaymentHeader, "eyJmYWtlIjoicGF5bWVudCJ9", "retry carried the X-PAYMENT header");
  assert.deepEqual(r.nextDeposit, ROTATED, "change note returned for reuse");
  assert.equal(r.amount, "10000");

  // Amount guard.
  await assert.rejects(
    zbase.payAndFetch(PROVIDER, {}, { deposit: DEPOSIT, maxAmountAtomic: 1n }),
    /Refusing to pay/,
    "must refuse when the 402 amount exceeds the cap",
  );

  // Stateful wrapper rotates the note across calls.
  let rotated: unknown = null;
  const buy = zbase.createPrivateFetch({ deposit: DEPOSIT, maxAmountAtomic: 50000n, onNoteRotate: (n) => (rotated = n) });
  const first = await buy(PROVIDER, { method: "POST", body: "{}" });
  assert.equal(first.paid, true);
  assert.deepEqual(rotated, ROTATED, "onNoteRotate fired with the change note");
  const before = settleCalls;
  const second = await buy(PROVIDER);
  assert.equal(second.paid, true);
  assert.equal(settleCalls, before + 1, "second buy settled again (using the rotated note)");

  // --- Regression: free-probe FAILS CLOSED (Codex P1). A seller that returns 200/500 to the
  // invalid-signature dummy did NOT verify it — the SDK must refuse WITHOUT settling. ---
  for (const [label, st, dbody] of [
    // 200/500 bodies that DO carry a verify-ish phrase — must still refuse (status-gated).
    ["200 {isValid:false}", 200, JSON.stringify({ report: { isValid: false } })],
    ["500 verify-ish", 500, JSON.stringify({ error: "upstream payment verification failed" })],
  ] as const) {
    let settled = false;
    const fetchImpl: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const u = typeof input === "string" ? input : input.toString();
      const h = new Headers(init?.headers);
      if (u === `${FACILITATOR}/api/facilitator/supported`) return jsonResponse(200, { customerReady: true });
      if (u === `${FACILITATOR}/api/facilitator/settle-x402`) { settled = true; return jsonResponse(200, { settled: true, xPayment: "x", payer: "0x1", amount: "10000", nextDeposit: CHANGE_NOTE }); }
      if (u === PROVIDER) { const xp = h.get("x-payment") ?? h.get("payment-signature"); return xp ? jsonResponse(st, dbody) : jsonResponse(402, PAYMENT_REQUIRED); }
      throw new Error(`unexpected: ${u}`);
    }) as typeof fetch;
    const z = createFacilitatorClient({ baseUrl: FACILITATOR, network: NETWORK, fetchImpl });
    const rp = await z.payAndFetch(PROVIDER, {}, { deposit: DEPOSIT, maxAmountAtomic: 50000n });
    assert.equal(rp.paid, false, `probe fail-closed (${label}): must not pay`);
    assert.equal(rp.compatible, false, `probe fail-closed (${label}): compatible=false`);
    assert.equal(settled, false, `probe fail-closed (${label}): settle-x402 NOT called — note untouched`);
  }

  // --- Regression (2026-07-22, learned from a real $0.01 loss): the probe must admit ONLY sellers
  // whose rejection of the dummy is SIGNATURE-SPECIFIC (a real signature would clear it), and refuse
  // sellers that return a GENERIC facilitator/validation error. A live pay to CoinGecko proved that
  // "Facilitator validation failed: ... returned 400 Bad Request" is returned to a REAL payment too —
  // it settles the note but never delivers. So that phrasing must STAY refused. Otto (names no
  // facilitator) and an empty-body 402 (kadec0) also stay refused. The signature-specific case
  // (BlockRun/onesource-class) is the positive control: it must still pay. ---
  for (const [label, dummyBody, wantPaid] of [
    ["signature-specific reject (deliverable)", { error: "Payment verification failed", details: "invalid signature: R is 0, isValid:false, invalid_exact_evm_payload_signature" }, true],
    ["CoinGecko generic facilitator-400 (settles-but-not-deliver)", { error: "Payment required", message: "Facilitator validation failed: Invalid payment: Facilitator returned 400 Bad Request with no error" }, false],
    ["Otto bespoke challenge", { error: "payment_required", hint: "pay-per-call x402 endpoint; price and payment options (networks, signed offers) are in the PAYMENT-REQUIRED header. Pay with an x402 client, then retry." }, false],
    ["empty-body 402 (kadec0)", {}, false],
  ] as const) {
    let settled = false;
    const fetchImpl: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const u = typeof input === "string" ? input : input.toString();
      const h = new Headers(init?.headers);
      if (u === `${FACILITATOR}/api/facilitator/supported`) return jsonResponse(200, { customerReady: true });
      if (u === `${FACILITATOR}/api/facilitator/settle-x402`) { settled = true; return jsonResponse(200, { settled: true, xPayment: "eyJmYWtlIjoicGF5bWVudCJ9", payer: "0x1", amount: "10000", nextDeposit: CHANGE_NOTE }); }
      if (u === PROVIDER) {
        const xp = h.get("x-payment") ?? h.get("payment-signature");
        if (!xp) return jsonResponse(402, PAYMENT_REQUIRED);
        // Invalid dummy → the verify-rejection phrasing under test; real settled header → deliver.
        if (xp !== "eyJmYWtlIjoicGF5bWVudCJ9") return jsonResponse(402, dummyBody);
        return jsonResponse(200, PROVIDER_DATA);
      }
      throw new Error(`unexpected: ${u}`);
    }) as typeof fetch;
    const z = createFacilitatorClient({ baseUrl: FACILITATOR, network: NETWORK, fetchImpl });
    const rp = await z.payAndFetch(PROVIDER, {}, { deposit: DEPOSIT, maxAmountAtomic: 50000n });
    assert.equal(rp.paid, wantPaid, `probe verify-phrasing (${label}): paid must be ${wantPaid}`);
    assert.equal(settled, wantPaid, `probe verify-phrasing (${label}): settle-x402 called == ${wantPaid}`);
    if (!wantPaid) assert.equal(rp.compatible, false, `probe verify-phrasing (${label}): compatible=false, note untouched`);
  }

  // --- Regression: NEVER throw after settlement (Codex P1). ---
  const settledMock = (afterSettle: (h: Headers) => Response): typeof fetch =>
    (async (input: string | URL | Request, init?: RequestInit) => {
      const u = typeof input === "string" ? input : input.toString();
      const h = new Headers(init?.headers);
      if (u === `${FACILITATOR}/api/facilitator/supported`) return jsonResponse(200, { customerReady: true });
      if (u === `${FACILITATOR}/api/facilitator/settle-x402`) return jsonResponse(200, { settled: true, xPayment: "eyJmYWtlIjoicGF5bWVudCJ9", payer: "0x1", amount: "10000", nextDeposit: CHANGE_NOTE });
      if (u === PROVIDER) {
        const xp = h.get("x-payment") ?? h.get("payment-signature");
        if (!xp) return jsonResponse(402, PAYMENT_REQUIRED);
        if (xp !== "eyJmYWtlIjoicGF5bWVudCJ9") return jsonResponse(402, { error: "invalid signature: R is 0, isValid:false" });
        return afterSettle(h);
      }
      throw new Error(`unexpected: ${u}`);
    }) as typeof fetch;

  // (a) provider rejects with an UNPRINTABLE value (String(e) throws) AFTER settlement.
  {
    const z = createFacilitatorClient({ baseUrl: FACILITATOR, network: NETWORK, fetchImpl: settledMock(() => { throw Object.create(null); }) });
    const r2 = await z.payAndFetch(PROVIDER, {}, { deposit: DEPOSIT, maxAmountAtomic: 50000n });
    assert.equal(r2.paid, true, "post-settle unprintable throw: paid:true (note IS spent)");
    assert.equal(r2.status, 0, "post-settle unprintable throw: status 0 (not delivered, do not retry)");
    assert.equal(r2.outcome, "settled_not_delivered", "post-settle non-2xx: outcome must NOT claim delivered (2026-08-03)");
    assert.deepEqual(r2.nextDeposit, ROTATED, "post-settle throw: change note still returned");
  }
  // (b) onNoteRotate throwing must NOT propagate (note spent; change is seed-recoverable).
  {
    const z = createFacilitatorClient({ baseUrl: FACILITATOR, network: NETWORK, fetchImpl: settledMock(() => jsonResponse(200, PROVIDER_DATA)) });
    const r3 = await z.payAndFetch(PROVIDER, {}, { deposit: DEPOSIT, maxAmountAtomic: 50000n, onNoteRotate: () => { throw new Error("disk full"); } });
    assert.equal(r3.paid, true, "onNoteRotate throw: still paid:true");
    assert.equal(r3.status, 200, "onNoteRotate throw: provider still delivered");
    assert.equal(r3.outcome, "delivered", "2xx provider response: outcome delivered");
  }

  // (c) settled:true with NO xPayment header → paid:true, status:0 (note spent, cannot deliver).
  {
    const fetchImpl: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const u = typeof input === "string" ? input : input.toString();
      const h = new Headers(init?.headers);
      if (u === `${FACILITATOR}/api/facilitator/supported`) return jsonResponse(200, { customerReady: true });
      if (u === `${FACILITATOR}/api/facilitator/settle-x402`) return jsonResponse(200, { settled: true, payer: "0x1", amount: "10000", nextDeposit: CHANGE_NOTE }); // no xPayment
      if (u === PROVIDER) { const xp = h.get("x-payment") ?? h.get("payment-signature"); return xp ? jsonResponse(402, { error: "invalid signature: R is 0, isValid:false" }) : jsonResponse(402, PAYMENT_REQUIRED); }
      throw new Error(`unexpected: ${u}`);
    }) as typeof fetch;
    const z = createFacilitatorClient({ baseUrl: FACILITATOR, network: NETWORK, fetchImpl });
    const r4 = await z.payAndFetch(PROVIDER, {}, { deposit: DEPOSIT, maxAmountAtomic: 50000n });
    assert.equal(r4.paid, true, "settled-without-header: paid:true (note IS spent)");
    assert.equal(r4.status, 0, "settled-without-header: status 0");
    assert.equal(r4.outcome, "settled_not_delivered", "settled-without-header: money left, value did not arrive");
  }

  // (d) settled:true with a MALFORMED nextDeposit (string) must NOT throw after settlement.
  {
    const z = createFacilitatorClient({ baseUrl: FACILITATOR, network: NETWORK, fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const u = typeof input === "string" ? input : input.toString();
      const h = new Headers(init?.headers);
      if (u === `${FACILITATOR}/api/facilitator/supported`) return jsonResponse(200, { customerReady: true });
      if (u === `${FACILITATOR}/api/facilitator/settle-x402`) return jsonResponse(200, { settled: true, xPayment: "eyJmYWtlIjoicGF5bWVudCJ9", payer: "0x1", amount: "10000", nextDeposit: "malformed" });
      if (u === PROVIDER) { const xp = h.get("x-payment") ?? h.get("payment-signature"); if (!xp) return jsonResponse(402, PAYMENT_REQUIRED); if (xp !== "eyJmYWtlIjoicGF5bWVudCJ9") return jsonResponse(402, { error: "invalid signature: R is 0, isValid:false" }); return jsonResponse(200, PROVIDER_DATA); }
      throw new Error(`unexpected: ${u}`);
    }) as typeof fetch });
    const r5 = await z.payAndFetch(PROVIDER, {}, { deposit: DEPOSIT, maxAmountAtomic: 50000n });
    assert.equal(r5.paid, true, "malformed nextDeposit: paid:true, no throw after settlement");
    assert.equal(r5.status, 200, "malformed nextDeposit: still delivered");
  }

  // --- Regression: a settle-x402 NETWORK error is retried idempotently (Part 2) rather than
  // reported as "unspent". The server keys the withdrawal on the nullifier, so a re-POST is
  // safe: the second attempt succeeds and the buy completes. ---
  {
    let settleAttempts = 0;
    const fetchImpl: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const u = typeof input === "string" ? input : input.toString();
      const h = new Headers(init?.headers);
      if (u === `${FACILITATOR}/api/facilitator/supported`) return jsonResponse(200, { customerReady: true });
      if (u === `${FACILITATOR}/api/facilitator/settle-x402`) {
        settleAttempts++;
        if (settleAttempts === 1) throw new Error("ECONNRESET"); // first attempt's response is lost
        return jsonResponse(200, { settled: true, xPayment: "eyJmYWtlIjoicGF5bWVudCJ9", payer: "0x1", amount: "10000", nextDeposit: CHANGE_NOTE });
      }
      if (u === PROVIDER) { const xp = h.get("x-payment") ?? h.get("payment-signature"); if (!xp) return jsonResponse(402, PAYMENT_REQUIRED); if (xp !== "eyJmYWtlIjoicGF5bWVudCJ9") return jsonResponse(402, { error: "invalid signature: R is 0, isValid:false" }); return jsonResponse(200, PROVIDER_DATA); }
      throw new Error(`unexpected: ${u}`);
    }) as typeof fetch;
    const z = createFacilitatorClient({ baseUrl: FACILITATOR, network: NETWORK, fetchImpl });
    const r6 = await z.payAndFetch(PROVIDER, {}, { deposit: DEPOSIT, maxAmountAtomic: 50000n });
    assert.equal(r6.paid, true, "settle network error: retried idempotently → paid:true");
    assert.equal(r6.status, 200, "settle retry: delivered");
    assert.ok(settleAttempts >= 2, "settle was retried after the network error");
  }

  // --- Regression (Codex Part-2 review): a PERSISTENT server-declared UNCERTAIN outcome
  // (settled:false, uncertain:true) must NOT throw "note unspent" — that would invite the caller
  // to re-pay from the change note (a double-pay). payAndFetch returns paid:false, uncertain:true,
  // status:0 (do NOT re-pay from another note; retry THIS settlement or check the chain). ---
  {
    let settleAttempts = 0;
    const fetchImpl: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const u = typeof input === "string" ? input : input.toString();
      const h = new Headers(init?.headers);
      if (u === `${FACILITATOR}/api/facilitator/supported`) return jsonResponse(200, { customerReady: true });
      if (u === `${FACILITATOR}/api/facilitator/settle-x402`) {
        settleAttempts++;
        return jsonResponse(500, { settled: false, uncertain: true, error: "withdrawal may have broadcast before failing" });
      }
      if (u === PROVIDER) { const xp = h.get("x-payment") ?? h.get("payment-signature"); if (!xp) return jsonResponse(402, PAYMENT_REQUIRED); if (xp !== "eyJmYWtlIjoicGF5bWVudCJ9") return jsonResponse(402, { error: "invalid signature: R is 0, isValid:false" }); return jsonResponse(200, PROVIDER_DATA); }
      throw new Error(`unexpected: ${u}`);
    }) as typeof fetch;
    const z = createFacilitatorClient({ baseUrl: FACILITATOR, network: NETWORK, fetchImpl });
    const r7 = await z.payAndFetch(PROVIDER, {}, { deposit: DEPOSIT, maxAmountAtomic: 50000n });
    assert.equal(r7.paid, false, "persistent uncertain: paid:false (does NOT claim success)");
    assert.equal(r7.uncertain, true, "persistent uncertain: uncertain:true (do not re-pay from another note)");
    assert.equal(r7.status, 0, "persistent uncertain: status 0 (not delivered)");
    assert.ok(settleAttempts >= 2, "uncertain outcome was retried (idempotent), not returned as proven-unspent");
  }

  // --- Regression: a PROVEN-unspent settle (settled:false WITHOUT uncertain, e.g. a 400 rejected
  // before spending) DOES throw "note unspent" — the note is definitively safe to retry, and it
  // must NOT loop through the uncertain retries. ---
  {
    let settleAttempts = 0;
    const fetchImpl: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const u = typeof input === "string" ? input : input.toString();
      const h = new Headers(init?.headers);
      if (u === `${FACILITATOR}/api/facilitator/supported`) return jsonResponse(200, { customerReady: true });
      if (u === `${FACILITATOR}/api/facilitator/settle-x402`) { settleAttempts++; return jsonResponse(400, { settled: false, error: "rejected before spending" }); }
      if (u === PROVIDER) { const xp = h.get("x-payment") ?? h.get("payment-signature"); if (!xp) return jsonResponse(402, PAYMENT_REQUIRED); if (xp !== "eyJmYWtlIjoicGF5bWVudCJ9") return jsonResponse(402, { error: "invalid signature: R is 0, isValid:false" }); return jsonResponse(200, PROVIDER_DATA); }
      throw new Error(`unexpected: ${u}`);
    }) as typeof fetch;
    const z = createFacilitatorClient({ baseUrl: FACILITATOR, network: NETWORK, fetchImpl });
    let threw = false;
    try { await z.payAndFetch(PROVIDER, {}, { deposit: DEPOSIT, maxAmountAtomic: 50000n }); } catch { threw = true; }
    assert.ok(threw, "proven-unspent: throws 'note unspent' (safe to retry with the same note)");
    assert.equal(settleAttempts, 1, "proven-unspent returns immediately — no uncertain retry loop");
  }

  // --- Message-only: diagnoseSellerFacilitatorFault explains a SELLER-side facilitator fault
  // (CoinGecko-class) as NOT-zBase, but stays silent on a normal verify rejection so we never
  // mislabel a real payment problem as "the seller is broken". ---
  {
    const cgFault = diagnoseSellerFacilitatorFault({ error: "Payment required", message: "Facilitator validation failed: Invalid payment: Facilitator returned 400 Bad Request with no error" });
    assert.ok(cgFault && /NOT zBase/i.test(cgFault), "CoinGecko-class facilitator-400 → diagnosed as seller-side, not zBase");
    // Normal verify rejections of the invalid dummy must NOT be diagnosed as a seller fault.
    assert.equal(diagnoseSellerFacilitatorFault({ error: "Payment verification failed" }), undefined, "BlockRun-style verify failure → not a seller-facilitator fault");
    assert.equal(diagnoseSellerFacilitatorFault({ error: "Payment invalid: invalid_payload" }), undefined, "onesource-style invalid_payload → not a seller-facilitator fault");
    assert.equal(diagnoseSellerFacilitatorFault({ error: "payment_required", hint: "pay-per-call x402; signed offers in the header" }), undefined, "Otto-style bespoke challenge → not a seller-facilitator fault");
    assert.equal(diagnoseSellerFacilitatorFault(""), undefined, "empty body → no diagnosis");
  }

  console.log("✓ privateFetch: 402 → probe → private settle → retry with both headers → data; note auto-rotates; fail-closed probe; never throws after settlement; settle retried idempotently on network error; tri-state uncertain never reported as unspent; proven-unspent still throws; seller-facilitator fault diagnosed (message-only). Agent buys privately in one call.");
}

main().catch((e) => {
  console.error("✗ test failed:", e);
  process.exit(1);
});
