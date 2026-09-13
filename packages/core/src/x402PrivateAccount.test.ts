/**
 * x402PrivateAccount.test.ts — zBase as a viem LocalAccount (x402-fetch/axios).
 *
 * Mock fetch; no server, no funds, no chain.
 *
 * Run: npx tsx packages/core/src/x402PrivateAccount.test.ts
 */
import * as assert from "node:assert/strict";
import { isAddress, verifyTypedData } from "viem";
import { createZBasePrivateAccount, deriveZBaseAccountKey } from "./x402PrivateAccount.js";

// index:0 ⇒ recoverable ⇒ passes the spend-guard (the guard is exercised separately).
const NOTE = { nullifier: "111", secret: "222", value: "990000", label: "333", commitment: "444", index: 0 };
const CHANGE = { nullifier: "555", secret: "666", value: "985000", label: "333", commitment: "777" };
// What the SDK rotates to: server change note + propagated recoverability, no HD index.
const ROTATED = { ...CHANGE, recoverable: true };

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = "0xDbAA23601A95a01ee9B90160F6aA784CBE4E0f21";

const TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

const DOMAIN = { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: USDC } as const;

const authFor = (from: string, value = "5000") => ({
  domain: DOMAIN,
  types: TYPES,
  primaryType: "TransferWithAuthorization" as const,
  message: {
    from,
    to: PAY_TO,
    value: BigInt(value),
    validAfter: 0n,
    validBefore: 9999999999n,
    nonce: ("0x" + "ab".repeat(32)) as `0x${string}`,
  },
});

const okRes = (body: unknown, okFlag = true) =>
  ({ ok: okFlag, status: okFlag ? 200 : 500, json: async () => body }) as unknown as Response;

let failed = false;
const ok = (m: string) => console.log("  PASS: " + m);
const bad = (m: string) => { console.log("  FAIL: " + m); failed = true; };

console.log("zBase private LocalAccount (x402-fetch / x402-axios)\n");

// 1. It is a viem LocalAccount — the thing x402-fetch's EvmSigner accepts.
{
  const a = createZBasePrivateAccount({ deposit: NOTE });
  isAddress(a.address) ? ok("has a real address") : bad("address");
  a.type === "local" ? ok("type === 'local' (satisfies EvmSigner = SignerWallet | LocalAccount)") : bad("type");
  typeof a.signTypedData === "function" ? ok("implements signTypedData") : bad("signTypedData");
  typeof a.publicKey === "string" ? ok("exposes publicKey") : bad("publicKey");
}

// 2. Deterministic ⇒ crash-recoverable; salt gives a distinct payer identity.
{
  const a = createZBasePrivateAccount({ deposit: NOTE });
  const b = createZBasePrivateAccount({ deposit: NOTE });
  a.address === b.address ? ok("same note → same payer EOA (re-derivable, funds never stranded)") : bad("determinism");

  const salted = createZBasePrivateAccount({ deposit: NOTE, accountSalt: "run-2" });
  salted.address !== a.address ? ok("accountSalt → different payer identity") : bad("salt");

  const k1 = deriveZBaseAccountKey(NOTE);
  const k2 = deriveZBaseAccountKey({ secret: "999", nullifier: "888" });
  k1 !== k2 ? ok("different notes → different keys") : bad("key collision");
  /^0x[0-9a-f]{64}$/.test(k1) ? ok("key is a well-formed 32-byte hex") : bad("key format");
}

// 3. Happy path: withdraws to E, then signs a VALID EIP-3009 signature.
{
  let body: any = null;
  const a = createZBasePrivateAccount({
    deposit: NOTE,
    fetchImpl: (async (_u: any, init: any) => {
      body = JSON.parse(init.body);
      return okRes({ nextDeposit: CHANGE });
    }) as any,
  });

  const sig = await a.signTypedData(authFor(a.address));

  body.recipient === a.address ? ok("withdraws to its OWN payer EOA") : bad("recipient: " + body.recipient);
  body.amountAtomic === "5000" ? ok("withdraws exactly the authorization's value") : bad("amount: " + body.amountAtomic);
  body.nullifier === NOTE.nullifier ? ok("spends the current note") : bad("note");

  const valid = await verifyTypedData({ ...authFor(a.address), address: a.address, signature: sig });
  valid ? ok("produces a VALID EIP-3009 signature from the funded EOA") : bad("signature does not verify");
}

// 4. Note rotation + persist-first.
{
  const saved: any[] = [];
  const a = createZBasePrivateAccount({
    deposit: NOTE,
    onNoteRotate: (n) => { saved.push(n); },
    fetchImpl: (async () => okRes({ nextDeposit: CHANGE })) as any,
  });
  await a.signTypedData(authFor(a.address));
  assert.deepEqual(saved, [ROTATED]);
  ok("onNoteRotate receives the change note");
  assert.deepEqual(a.currentNote, ROTATED);
  ok("rotates to the change note");
}
{
  const a = createZBasePrivateAccount({
    deposit: NOTE,
    onNoteRotate: () => { throw new Error("disk full"); },
    fetchImpl: (async () => okRes({ nextDeposit: CHANGE })) as any,
  });
  await assert.rejects(() => a.signTypedData(authFor(a.address)), /disk full/);
  ok("a throwing onNoteRotate FAILS the signature (never silently forfeits the change)");
}

// 5. The address is FIXED across rotation — the documented trade-off.
{
  const a = createZBasePrivateAccount({
    deposit: NOTE,
    fetchImpl: (async () => okRes({ nextDeposit: CHANGE })) as any,
  });
  const before = a.address;
  await a.signTypedData(authFor(a.address));
  a.address === before
    ? ok("payer EOA stays fixed after rotation (payments link to each other, NOT to the deposit)")
    : bad("address changed");
}

// 6. Guards run BEFORE any withdrawal.
{
  const a = createZBasePrivateAccount({
    deposit: NOTE,
    maxAmountAtomic: "1000",
    fetchImpl: (async () => { throw new Error("must not be called"); }) as any,
  });
  await assert.rejects(() => a.signTypedData(authFor(a.address)), /Refusing to sign/);
  ok("maxAmountAtomic refuses BEFORE withdrawing");
}
{
  const a = createZBasePrivateAccount({
    deposit: NOTE,
    fetchImpl: (async () => { throw new Error("must not be called"); }) as any,
  });
  await assert.rejects(
    () => a.signTypedData(authFor("0x000000000000000000000000000000000000dEaD")),
    /is not this account/,
  );
  ok("refuses an authorization whose `from` is not the funded EOA");
}

// 7. Non-x402 typed data is signed normally — never silently funded.
{
  let called = false;
  const a = createZBasePrivateAccount({
    deposit: NOTE,
    fetchImpl: (async () => { called = true; return okRes({}); }) as any,
  });
  const sig = await a.signTypedData({
    domain: DOMAIN,
    types: { Mail: [{ name: "contents", type: "string" }] },
    primaryType: "Mail",
    message: { contents: "hello" },
  });
  !called ? ok("non-TransferWithAuthorization does NOT touch the pool") : bad("unexpected withdrawal");
  sig.startsWith("0x") ? ok("still signs unrelated typed data normally") : bad("sig");
}

// 8. Real failures surface with the unspent-note guarantee intact.
{
  const a = createZBasePrivateAccount({
    deposit: NOTE,
    fetchImpl: (async () => okRes({ error: "Commitment not found in state tree" }, false)) as any,
  });
  await assert.rejects(() => a.signTypedData(authFor(a.address)), /Commitment not found/);
  ok("propagates the withdraw error");
  assert.deepEqual(a.currentNote, NOTE);
  ok("failed payment leaves the note UNSPENT (safe to retry)");
}

// 9. Exhausted note.
{
  const a = createZBasePrivateAccount({
    deposit: NOTE,
    fetchImpl: (async () => okRes({})) as any, // no change note → fully spent
  });
  await a.signTypedData(authFor(a.address));
  a.currentNote === undefined ? ok("note fully spent → currentNote undefined") : bad("currentNote");
  await assert.rejects(() => a.signTypedData(authFor(a.address)), /no spendable note left/);
  ok("exhausted note gives an actionable error");
}

// 10. baseUrl safety.
{
  assert.throws(() => createZBasePrivateAccount({ deposit: NOTE, baseUrl: "http://evil.example.com" }));
  ok("rejects a non-https baseUrl (spend secrets travel to it)");
}

console.log(failed ? "\nFAILED" : "\nzBase private account: all invariants hold");
process.exit(failed ? 1 : 0);
