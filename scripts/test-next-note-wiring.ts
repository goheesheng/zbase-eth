/**
 * test-next-note-wiring.ts — the change note must actually reach the server, and it must
 * be PARENT-KEYED so the rotation chain is recoverable and collision-proof.
 *
 * /api/withdraw accepts caller-supplied change-note secrets; this asserts every SDK path
 * sends them, always (never random anymore), and — the subtle one — that the chain
 * survives more than one payment: payment #2's change derives from payment #1's change,
 * not from a shared HD index (which used to collide with the next deposit).
 *
 * Mock fetch throughout — no server, no chain, no funds.
 *
 * Run: npx tsx scripts/test-next-note-wiring.ts
 */
import {
  createFacilitatorClient,
  createZBaseExactClient,
  createZBasePrivateAccount,
  deriveChangeNote,
  deriveForwardingNote,
  generateNewMnemonic,
  nextNoteFrom,
} from "../packages/core/src/index.ts";

let failed = false;
const ok = (m: string) => console.log("  PASS: " + m);
const bad = (m: string) => { console.log("  FAIL: " + m); failed = true; };

console.log("next-note wiring — parent-keyed change notes reach every SDK path\n");

const mnemonic = generateNewMnemonic();
/** A seed-derived deposit (has index ⇒ recoverable ⇒ passes the spend-guard). */
const seedNote = (i: number) => {
  const n = deriveForwardingNote(mnemonic, i);
  return { nullifier: n.nullifier, secret: n.secret, value: "990000", label: "333", commitment: "444", index: i };
};

const HEADER = Buffer.from(
  JSON.stringify({ x402Version: 2, scheme: "exact", network: "eip155:8453", payload: { signature: "0xsig", authorization: {} } }),
).toString("base64");

const REQS = {
  scheme: "exact", network: "eip155:8453",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  amount: "5000", payTo: "0xDbAA23601A95a01ee9B90160F6aA784CBE4E0f21",
  maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" },
};

// 1. nextNoteFrom: parent-keyed, deterministic, always defined.
{
  const note = seedNote(0);
  const n1 = nextNoteFrom(note);
  const expected = deriveChangeNote(note);
  n1.nullifier === expected.nullifier && n1.secret === expected.secret
    ? ok("nextNoteFrom(note) === deriveChangeNote(note) — parent-keyed, not index+1")
    : bad("wrong derivation");

  // A legacy random note (no index) STILL yields a derivable change — from its own
  // secrets. This is the improvement: even legacy notes get a re-derivable change.
  const legacy = { ...note, index: undefined };
  const nLegacy = nextNoteFrom(legacy);
  nLegacy.nullifier === deriveChangeNote(legacy).nullifier
    ? ok("legacy note (no index) still yields a parent-keyed change (never random)")
    : bad("legacy note produced wrong change");
}

// 2. The @x402/core scheme client SENDS them (always).
{
  let body: any = null;
  const c = createZBaseExactClient({
    deposit: seedNote(0),
    fetchImpl: (async (_u: any, init: any) => {
      body = JSON.parse(init.body);
      return { json: async () => ({ settled: true, xPayment: HEADER, nextDeposit: { value: "985000", label: "333", commitment: "555", nullifier: body.nextNullifier, secret: body.nextSecret } }) } as any;
    }) as any,
  });
  await c.createPaymentPayload(2, REQS);
  const want = deriveChangeNote(seedNote(0));
  body.nextNullifier === want.nullifier && body.nextSecret === want.secret
    ? ok("ZBaseExactClient sends parent-keyed nextNullifier/nextSecret")
    : bad("scheme client did not send derived secrets");
}

// 3. THE CHAIN. Two payments: #2's change derives from #1's change, not a shared index.
{
  const sent: any[] = [];
  const c = createZBaseExactClient({
    deposit: seedNote(0),
    fetchImpl: (async (_u: any, init: any) => {
      const b = JSON.parse(init.body);
      sent.push(b);
      // Echo the secrets we sent as the change note — as the real facilitator does.
      return {
        json: async () => ({
          settled: true, xPayment: HEADER,
          nextDeposit: { nullifier: b.nextNullifier, secret: b.nextSecret, value: "985000", label: "333", commitment: "555" },
        }),
      } as any;
    }) as any,
  });

  await c.createPaymentPayload(2, REQS);
  await c.createPaymentPayload(2, REQS);

  const change1 = deriveChangeNote(seedNote(0));            // change of the deposit
  const change2 = deriveChangeNote(change1);                // change of that change
  sent[0].nextNullifier === change1.nullifier ? ok("payment #1 change = deriveChangeNote(deposit)") : bad("payment #1 wrong");
  sent[1].nextNullifier === change2.nullifier
    ? ok("payment #2 change = deriveChangeNote(change1) — the chain SURVIVES via parent-keying")
    : bad("payment #2 broke the chain");
  // The rotated note inherits recoverability from the seed-derived root (no HD index).
  c.currentNote?.recoverable === true ? ok("currentNote.recoverable propagated down the lineage") : bad("recoverable not propagated: " + JSON.stringify(c.currentNote));
  c.currentNote?.index === undefined ? ok("...and carries NO HD index (change notes are not indexed — collision-proof)") : bad("change note wrongly indexed");
}

// 4. The viem LocalAccount adapter sends them to /api/withdraw.
{
  let body: any = null;
  const a = createZBasePrivateAccount({
    deposit: seedNote(0),
    fetchImpl: (async (_u: any, init: any) => {
      body = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ nextDeposit: { value: "985000", label: "333", commitment: "555", nullifier: body.nextNullifier, secret: body.nextSecret } }) } as any;
    }) as any,
  });
  await a.signTypedData({
    domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: REQS.asset },
    types: { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
    primaryType: "TransferWithAuthorization",
    message: { from: a.address, to: REQS.payTo, value: 5000n, validAfter: 0n, validBefore: 9999999999n, nonce: ("0x" + "ab".repeat(32)) as `0x${string}` },
  });
  const want = deriveChangeNote(seedNote(0));
  body.nextNullifier === want.nullifier ? ok("ZBasePrivateAccount sends parent-keyed nextNullifier to /api/withdraw") : bad("account did not send derived secrets");
}

// 5. payAndFetch sends them.
{
  let settleBody: any = null;
  const client = createFacilitatorClient({ baseUrl: "https://zbase.app", network: "eip155:8453" });
  (client as any).doFetch = async (url: string, init: any) => {
    if (url.includes("settle-x402")) {
      settleBody = JSON.parse(init.body);
      return { json: async () => ({ settled: true, xPayment: HEADER, nextDeposit: { nullifier: settleBody.nextNullifier, secret: settleBody.nextSecret, value: "985000", label: "333", commitment: "555" } }) };
    }
    // The seller. payAndFetch free-probes before settling, so this must answer like a REAL x402
    // verifier: reject the probe's deliberately-invalid signature with 402 + a verifier-error body.
    // Returning a bare 402 "{}" fails the probe's VERIFY_HINT, the client fails closed, and the
    // settle below never happens — which reddened this assertion for the wrong reason (2026-08-03).
    const paymentRequired = new Headers({ "payment-required": Buffer.from(JSON.stringify({ x402Version: 2, accepts: [REQS] })).toString("base64") });
    const payment = init?.headers?.["X-PAYMENT"];
    if (payment && payment !== HEADER) {
      return { status: 402, headers: paymentRequired, json: async () => ({ error: "invalid signature" }), text: async () => '{"error":"invalid signature"}' };
    }
    if (!settleBody) {
      return { status: 402, headers: paymentRequired, json: async () => ({}), text: async () => "{}" };
    }
    return { status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ ok: true }), text: async () => '{"ok":true}' };
  };
  await client.payAndFetch("https://api.provider.ai/x", {}, { deposit: seedNote(0) });
  const want = deriveChangeNote(seedNote(0));
  settleBody?.nextNullifier === want.nullifier ? ok("payAndFetch forwards the parent-keyed next note") : bad("payAndFetch did not forward");
}

// 6. THE GUARD. A legacy random note (not recoverable) with no persistence must be
//    REFUSED before spending; the same note WITH onNoteRotate is allowed.
{
  const randomNote = { ...seedNote(0), index: undefined }; // no recoverable lineage
  let spent = false;
  const mk = (onNoteRotate?: any) => createZBaseExactClient({
    deposit: randomNote,
    onNoteRotate,
    fetchImpl: (async (u: any, init: any) => {
      const url = String(u);
      // Only a settle counts as "spent" — the /supported readiness check fires first and
      // must not be mistaken for a spend.
      if (url.includes("settle-x402")) {
        spent = true;
        const b = JSON.parse(init.body);
        return { json: async () => ({ settled: true, xPayment: HEADER, nextDeposit: { nullifier: b.nextNullifier, secret: b.nextSecret, value: "985000", label: "333", commitment: "555" } }) } as any;
      }
      return { json: async () => ({ customerReady: true }) } as any; // /supported
    }) as any,
  });

  spent = false;
  try {
    await mk().createPaymentPayload(2, REQS);
    bad("guard did NOT fire on an unrecoverable note with no persistence");
  } catch (e) {
    /would not be recoverable/.test((e as Error).message) ? ok("unrecoverable note + no onNoteRotate => REFUSED (the guard)") : bad("wrong error: " + (e as Error).message);
    spent === false ? ok("...and nothing was spent (refused before the request)") : bad("spent despite refusal");
  }

  let saved: any = null;
  await mk((n: any) => { saved = n; }).createPaymentPayload(2, REQS);
  saved && saved.recoverable !== true ? ok("with onNoteRotate: allowed, and the change is persisted (recoverable:false, honestly)") : bad("onNoteRotate path wrong: " + JSON.stringify(saved));
}

console.log(failed ? "\nFAILED" : "\nNEXT-NOTE WIRING: parent-keyed, chained, guarded on every path");
process.exit(failed ? 1 : 0);
