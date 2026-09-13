/**
 * Offline test of opt-in seller privacy (Slice 4): note derivation from the
 * seller's existing HD wallet is deterministic; the registration message + body
 * are correct and signed; and a derived note round-trips through the recover path.
 *
 *   npx tsx src/lib/private-payout.test.ts
 */
import * as assert from "node:assert/strict";
import { computeCommitment } from "@zbase-protocol/core";
import { derivePayoutNote, buildPayoutRegistration, enablePrivatePayout, recoverPrivatePayoutNotes } from "./private-payout.js";

const MNEMONIC = "test test test test test test test test test test test junk";
const WATCHED = "0xBf6926870E679DB20220Ac40F975Eb8925dFafff" as const;

async function main() {
  // Deterministic + index-scoped derivation (recoverable from the wallet alone).
  const n0a = derivePayoutNote(MNEMONIC, 0);
  const n0b = derivePayoutNote(MNEMONIC, 0);
  assert.equal(n0a.precommitment, n0b.precommitment, "same mnemonic+index → same note");
  assert.notEqual(derivePayoutNote(MNEMONIC, 1).precommitment, n0a.precommitment, "index scopes the note");

  // Registration payload + canonical message.
  const reg = buildPayoutRegistration({ watchedAddress: WATCHED, mnemonic: MNEMONIC, index: 0, network: "sepolia" });
  assert.equal(reg.body.authorityMode, "b1");
  assert.equal(reg.body.precommitment, n0a.precommitment);
  assert.equal(reg.body.network, "sepolia");
  assert.ok(reg.message.includes(`precommitment:${n0a.precommitment}`));
  assert.ok(reg.message.includes(`address:${WATCHED.toLowerCase()}`));

  // enablePrivatePayout signs + POSTs the right body.
  let posted: Record<string, unknown> | null = null;
  const mockFetch: typeof fetch = (async (_url: string, init?: RequestInit) => {
    posted = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const out = await enablePrivatePayout({
    baseUrl: "https://zbase.app",
    watchedAddress: WATCHED,
    mnemonic: MNEMONIC,
    index: 0,
    network: "sepolia",
    signMessage: () => ("0x" + "ab".repeat(65)) as `0x${string}`,
    fetchImpl: mockFetch,
  });
  assert.equal(out.registered, true);
  assert.equal(out.note.precommitment, n0a.precommitment);
  assert.equal(posted!.precommitment, n0a.precommitment);
  assert.equal(posted!.authorityMode, "b1");
  assert.equal(posted!.signature, "0x" + "ab".repeat(65));

  // Recover round-trip: a pool Deposited event for this note's index is recovered.
  const note = derivePayoutNote(MNEMONIC, 3);
  const value = "990000";
  const label = "42";
  const commitment = computeCommitment(value, label, note.precommitment);
  const recovered = recoverPrivatePayoutNotes(MNEMONIC, [{ commitment, label, value }], 5);
  assert.equal(recovered.length, 1, "the seller's deposit is recovered from events");
  assert.equal(recovered[0].precommitment, note.precommitment);
  assert.equal(recovered[0].value, value);
  assert.equal(recovered[0].commitment, commitment);

  console.log("✓ private-payout: HD note derivation (no meta-address) + signed registration + recover round-trip");
}

main().catch((e) => { console.error("✗ test failed:", e); process.exit(1); });
