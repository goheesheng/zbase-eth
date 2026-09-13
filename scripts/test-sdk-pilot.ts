/**
 * test-sdk-pilot.ts — the SDK must never let a not-private payment look private, and must
 * never pay through a pilot without the caller's explicit consent.
 *
 * The failure this guards is quiet by construction: a pilot payment succeeds exactly like
 * a private one — same Groth16 proof, same fresh payer EOA, same provider response, same
 * 200. The ONLY difference is the disclosure. So every assertion here is about the
 * disclosure surviving the trip from the facilitator to the caller.
 *
 * The mock speaks the facilitator's REAL wire shape (blockingReasons as {code,message,
 * blocks} objects, `pilot` block, `privacy` on settle). Mocks that drifted from the real
 * shape are how the [object Object] bug in FacilitatorNotReadyError shipped.
 *
 * There is no credential in any of this: the facilitator's pilot is open to anyone who has
 * deposited (see src/lib/pilot.ts for why a key bought nothing). So what the SDK owes the
 * caller is not a key — it is (a) an explicit `acceptNotPrivate` decision made in their own
 * code, and (b) the disclosure, intact, on every result.
 *
 * Run: npx tsx scripts/test-sdk-pilot.ts
 */
import { FacilitatorClient, FacilitatorNotReadyError } from "../packages/core/src/facilitatorClient";
import { ZBaseExactClient } from "../packages/core/src/x402SchemeClient";

let failed = false;
const ok = (m: string) => console.log("  PASS: " + m);
const bad = (m: string) => { console.log("  FAIL: " + m); failed = true; };

const NOTE = {
  nullifier: "1", secret: "2", value: "1000000",
  label: "3", commitment: "4", index: 0,
};

/** /supported exactly as a piloting facilitator publishes it. */
const supportedPilot = {
  x402Version: 2,
  status: "pilot",
  customerReady: false,
  pilotReady: true,
  verificationReady: true,
  description: "PILOT — settlement works but payments are NOT private yet.",
  supported: [], // the real off-switch: a pilot is not a public rail
  pilot: {
    enabled: true,
    anonymitySet: 1,
    minimumForPrivacy: 30,
    howToJoin: "Open to anyone who deposits — no key. SDK callers must pass acceptNotPrivate:true.",
  },
  blockingReasons: [
    {
      code: "ANONYMITY_SET_BELOW_MINIMUM",
      message: "The anonymity set is 1 independent depositor(s); customer use requires at least 30.",
      blocks: ["customer"],
    },
  ],
};

/** A closed facilitator with NO pilot — an older deployment, or one that never opened one. */
const supportedClosed = {
  customerReady: false,
  verificationReady: true,
  supported: [],
  blockingReasons: [
    { code: "ANONYMITY_SET_BELOW_MINIMUM", message: "The anonymity set is 1.", blocks: ["customer"] },
  ],
};

const settleOk = (isPrivate: boolean) => ({
  settled: true,
  xPayment: Buffer.from(JSON.stringify({ payload: { authorization: {}, signature: "0xsig" } })).toString("base64"),
  payer: "0xPAYER",
  amount: "1000",
  fundingTxHash: "0xfund",
  nextDeposit: { nullifier: "5", secret: "6", value: "999000", label: "3", commitment: "7" },
  privacy: isPrivate
    ? { private: true, linkable: false, anonymitySet: 40, minimumForPrivacy: 30, disclosure: "Private." }
    : {
        private: false, linkable: true, anonymitySet: 1, minimumForPrivacy: 30,
        disclosure: "PILOT — THIS PAYMENT IS NOT PRIVATE. The pool currently has 1 independent depositor(s); privacy requires at least 30.",
      },
});

/** Records every request so we can assert what actually went over the wire. */
function mockFetch(opts: { supported: unknown; isPrivate?: boolean }) {
  const seen: Array<{ url: string; headers: Record<string, string>; body?: string }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    seen.push({ url, headers, body: init?.body as string | undefined });

    const json = (b: unknown, status = 200) =>
      new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

    if (url.includes("/api/facilitator/supported")) return json(opts.supported);
    if (url.includes("/api/facilitator/settle-x402")) return json(settleOk(opts.isPrivate ?? false));
    // The provider: 402 first; a standard facilitator parses the deliberately invalid
    // free-probe payload and rejects its all-zero signature with a verifier-specific
    // 402; only the real signed payload returned by settle-x402 receives the goods.
    // Returning 200 for the dummy would correctly make the hardened client fail closed,
    // because it would not prove that the seller actually verifies x402 payments.
    if (headers["x-payment"]) {
      let payment: { payload?: { signature?: string } } | undefined;
      try {
        payment = JSON.parse(Buffer.from(headers["x-payment"], "base64").toString("utf8"));
      } catch {
        // Malformed payment payloads are rejected by the mock verifier below.
      }
      if (payment?.payload?.signature === "0x" + "00".repeat(65)) {
        return json({ error: "invalid signature: R is 0" }, 402);
      }
      return json({ data: "the goods" });
    }
    return json(
      { x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", amount: "1000", asset: "0xUSDC", payTo: "0xSELLER", resource: url, extra: { name: "USDC", version: "2" } }] },
      402,
    );
  }) as typeof fetch;
  return { impl, seen };
}

console.log("SDK pilot — consent is explicit, the disclosure survives\n");

// 1. NO CONSENT on a piloting facilitator => refused, and TOLD how to proceed.
{
  const { impl } = mockFetch({ supported: supportedPilot });
  const z = new FacilitatorClient({ baseUrl: "https://zbase.app", fetchImpl: impl });
  try {
    await z.payAndFetch("https://api.seller.ai/x", {}, { deposit: NOTE });
    bad("a caller who never consented was paid through a not-private facilitator");
  } catch (e) {
    if (!(e instanceof FacilitatorNotReadyError)) { bad("wrong error type: " + (e as Error).message); }
    else {
      ok("no consent => FacilitatorNotReadyError (the gate holds)");
      e.pilotAvailable ? ok("...pilotAvailable:true tells the caller a path exists") : bad("pilotAvailable false on a piloting facilitator");
      /acceptNotPrivate/.test(e.message) ? ok("...and the message names acceptNotPrivate as the way in") : bad("message does not mention acceptNotPrivate");
      !/key/i.test(e.message.replace(/acceptNotPrivate/g, "")) || /No key is needed/.test(e.message)
        ? ok("...and does NOT send them hunting for a credential") : bad("message implies a key is needed");
      /NOT ready/.test(e.message) ? ok("...while still saying it is not ready") : bad("message softened");
      e.codes.includes("ANONYMITY_SET_BELOW_MINIMUM") ? ok("...and codes[] is machine-readable") : bad("codes missing");
      !/\[object Object\]/.test(e.message) ? ok("...and renders reasons, not [object Object]") : bad("[object Object] regression");
    }
  }
}

// 2. A closed facilitator with NO pilot must NOT advertise one. Offering a path that does
//    not exist is worse than saying nothing.
{
  const { impl } = mockFetch({ supported: supportedClosed });
  const z = new FacilitatorClient({ baseUrl: "https://zbase.app", fetchImpl: impl });
  try {
    await z.payAndFetch("https://api.seller.ai/x", {}, { deposit: NOTE });
    bad("caller allowed with no consent");
  } catch (e) {
    const err = e as FacilitatorNotReadyError;
    err.pilotAvailable === false ? ok("no pilot block => pilotAvailable:false") : bad("invented a pilot");
    !/acceptNotPrivate/.test(err.message) ? ok("...and the error does not advertise a pilot that isn't running") : bad("advertised a nonexistent pilot");
  }
}

// 3. WITH consent: the payment goes through, and the disclosure comes back with it.
{
  const { impl } = mockFetch({ supported: supportedPilot });
  const z = new FacilitatorClient({ baseUrl: "https://zbase.app", fetchImpl: impl, acceptNotPrivate: true });
  const r = await z.payAndFetch("https://api.seller.ai/x", {}, { deposit: NOTE });

  r.paid ? ok("client-level acceptNotPrivate => payment proceeds") : bad("payment did not proceed");

  // THE POINT: the disclosure must survive to the caller.
  r.privacy?.private === false ? ok("...result.privacy.private is FALSE (the disclosure survived)") : bad("privacy block lost or claims privacy");
  r.privacy?.linkable === true ? ok("...linkable:true") : bad("linkable not surfaced");
  /NOT PRIVATE/.test(r.privacy?.disclosure ?? "") ? ok("...and the plain-language disclosure came through") : bad("disclosure text lost");
  r.privacy?.anonymitySet === 1 ? ok("...with the live set (1)") : bad("set not surfaced");
}

// 4. NO CREDENTIAL travels anywhere. There is no key by design, so nothing key-shaped
//    should reach the facilitator OR the seller. This is what stops the credential
//    creeping back in later and quietly ending up on a third-party request.
{
  const { impl, seen } = mockFetch({ supported: supportedPilot });
  const z = new FacilitatorClient({ baseUrl: "https://zbase.app", fetchImpl: impl, acceptNotPrivate: true });
  await z.payAndFetch("https://api.seller.ai/x", { headers: { "X-Custom": "v" } }, { deposit: NOTE });

  const anyKeyHeader = seen.some((s) => Object.keys(s.headers).some((h) => /pilot|key|secret|auth/i.test(h)));
  !anyKeyHeader ? ok("no credential header on ANY request (the pilot needs none)") : bad("a credential-shaped header appeared: " + JSON.stringify(seen.map((x) => Object.keys(x.headers))));

  // acceptNotPrivate is a LOCAL decision. Shipping it to the facilitator would turn
  // consent into a request field the server might one day honour — the exact shape
  // settle-readiness.ts forbids ("a caller must never talk the facilitator out of its
  // own launch gate").
  const settleBody = seen.find((s) => s.url.includes("settle-x402"))?.body ?? "";
  !/acceptNotPrivate/.test(settleBody)
    ? ok("acceptNotPrivate stays LOCAL — never sent as a request field the server could honour")
    : bad("acceptNotPrivate was sent to the server — consent must not be a request field");
  seen.some((s) => s.url.includes("api.seller.ai") && s.headers["x-payment"]) ? ok("...while X-PAYMENT still reaches the seller") : bad("X-PAYMENT missing");
}

// 5. Per-call consent works without client-level consent — and its ABSENCE still refuses.
{
  const { impl } = mockFetch({ supported: supportedPilot });
  const z = new FacilitatorClient({ baseUrl: "https://zbase.app", fetchImpl: impl });
  const r = await z.payAndFetch("https://api.seller.ai/x", {}, { deposit: NOTE, acceptNotPrivate: true });
  r.paid ? ok("a per-call acceptNotPrivate is enough on its own") : bad("per-call consent ignored");

  // The same client, same facilitator, WITHOUT the flag: must still refuse. Consent is
  // per-decision, not sticky.
  try {
    await z.payAndFetch("https://api.seller.ai/y", {}, { deposit: NOTE });
    bad("consent leaked across calls — one accepted call opened the rest");
  } catch (e) {
    e instanceof FacilitatorNotReadyError ? ok("...and it does NOT leak to the next call (consent is per-decision)") : bad("wrong error");
  }
}

// 6. createPrivateFetch threads consent AND keeps disclosing on every call — not just the
//    first. A disclosure that fades after call #1 is how a long-running agent forgets.
{
  const { impl, seen } = mockFetch({ supported: supportedPilot });
  const z = new FacilitatorClient({ baseUrl: "https://zbase.app", fetchImpl: impl, acceptNotPrivate: true });
  const buy = z.createPrivateFetch({ deposit: NOTE });
  const a = await buy("https://api.seller.ai/x");
  const b = await buy("https://api.seller.ai/y");
  a.privacy?.private === false && b.privacy?.private === false
    ? ok("createPrivateFetch discloses on EVERY call, not just the first")
    : bad("disclosure faded across calls");
  seen.filter((s) => s.url.includes("settle-x402")).length === 2
    ? ok("...and both buys actually settled")
    : bad("a buy did not settle");
}

// 7. A CUSTOMER-READY facilitator must not be mislabeled. private:true must pass through
//    intact, or the tier is just a different flavour of lying.
{
  const { impl } = mockFetch({
    supported: { customerReady: true, verificationReady: true, supported: [{ scheme: "exact" }] },
    isPrivate: true,
  });
  const z = new FacilitatorClient({ baseUrl: "https://zbase.app", fetchImpl: impl });
  const r = await z.payAndFetch("https://api.seller.ai/x", {}, { deposit: NOTE });
  r.privacy?.private === true ? ok("a customer-ready facilitator reports private:true unchanged") : bad("private:true mangled");
}

// 8. The @x402/core adapter. Its interface returns ONLY a payment payload, so the
//    disclosure has nowhere to go — it must not simply vanish.
{
  const { impl, seen } = mockFetch({ supported: supportedPilot });
  const disclosed: Array<{ private: boolean }> = [];
  const c = new ZBaseExactClient({
    deposit: NOTE, baseUrl: "https://zbase.app", fetchImpl: impl, acceptNotPrivate: true,
    onPrivacyDisclosure: (p) => disclosed.push(p),
  });
  await c.createPaymentPayload(2, {
    scheme: "exact", network: "eip155:8453", amount: "1000",
    asset: "0xUSDC", payTo: "0xSELLER", resource: "https://api.seller.ai/x",
    extra: { name: "USDC", version: "2" },
  } as never);

  seen.some((s) => s.url.includes("settle-x402"))
    ? ok("scheme client settles when consent is given")
    : bad("scheme client did not settle");
  disclosed.length === 1 && disclosed[0].private === false
    ? ok("...and pushes the disclosure to onPrivacyDisclosure (the only seam that can)")
    : bad("scheme client swallowed the disclosure");
  c.lastPrivacy?.private === false ? ok("...and exposes it on lastPrivacy for pull-style callers") : bad("lastPrivacy not set");
}

// 8b. With NO handler wired, a not-private payment must still be loud. Silence is
//     indistinguishable from privacy.
{
  const { impl } = mockFetch({ supported: supportedPilot });
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...a: unknown[]) => { warnings.push(a.join(" ")); };
  try {
    const c = new ZBaseExactClient({ deposit: NOTE, baseUrl: "https://zbase.app", fetchImpl: impl, acceptNotPrivate: true });
    await c.createPaymentPayload(2, {
      scheme: "exact", network: "eip155:8453", amount: "1000",
      asset: "0xUSDC", payTo: "0xSELLER", resource: "https://api.seller.ai/x",
      extra: { name: "USDC", version: "2" },
    } as never);
  } finally {
    console.warn = realWarn;
  }
  warnings.some((w) => /NOT private/i.test(w))
    ? ok("no handler => warns anyway (silence would read as privacy)")
    : bad("a not-private payment passed silently with no handler");
}

// 9. THE CONSENT GATE on the adapter most likely to be wired in and forgotten. Without
//    acceptNotPrivate it must REFUSE — otherwise the flag is decorative and someone who
//    registered zBase for privacy silently gets none, forever, with no error.
{
  const { impl, seen } = mockFetch({ supported: supportedPilot });
  const c = new ZBaseExactClient({ deposit: NOTE, baseUrl: "https://zbase.app", fetchImpl: impl });
  try {
    await c.createPaymentPayload(2, {
      scheme: "exact", network: "eip155:8453", amount: "1000",
      asset: "0xUSDC", payTo: "0xSELLER", resource: "https://api.seller.ai/x",
      extra: { name: "USDC", version: "2" },
    } as never);
    bad("scheme client paid through a pilot with NO consent — acceptNotPrivate is decorative");
  } catch (e) {
    e instanceof FacilitatorNotReadyError
      ? ok("scheme client REFUSES without acceptNotPrivate (the flag is load-bearing)")
      : bad("wrong error: " + (e as Error).message);
    seen.some((s) => s.url.includes("settle-x402"))
      ? bad("...but it spent the note first — a refusal must cost nothing")
      : ok("...and the note was never spent (refused before settling)");
  }
}

console.log(failed ? "\nFAILED" : "\nSDK PILOT: no credential anywhere, consent is explicit, disclosure reaches the caller");
process.exit(failed ? 1 : 0);
