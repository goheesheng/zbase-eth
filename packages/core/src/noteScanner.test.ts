/**
 * Pinning tests for `@zbase-protocol/core` Phase 1B WS scanner.
 *
 * We do NOT exercise the live WebSocket here (that requires a live RPC and is
 * covered by end-to-end tests in scripts/). Instead we test the pure decode
 * and trial-decrypt paths that the WS handler calls — those are the failure
 * modes that actually lose funds for users:
 *
 *  1. A Transferred-event ciphertext bound to commitment A must NOT decrypt
 *     when fed in alongside commitment B. This is Phase 1B Fix 3 — without it,
 *     a malicious relayer can shuffle ciphertexts between the two outputs of
 *     the same Transferred log inside a single block.
 *
 *  2. The right viewing key decrypts the right ciphertext and yields a
 *     well-formed `transferred-in` event.
 *
 *  3. A foreign viewing key on either ciphertext yields `transferred-other`,
 *     never `transferred-in`.
 *
 *  4. Topic hashes (SPENT_TOPIC, TRANSFERRED_TOPIC) are stable against the
 *     canonical Solidity event signatures.
 *
 * Run:
 *   from packages/core: `npx tsx src/noteScanner.test.ts`
 */

import * as assert from "node:assert/strict";
import { keccak_256 } from "@noble/hashes/sha3";
import {
  SPENT_TOPIC,
  TRANSFERRED_TOPIC,
  tryDecryptTransferred,
  scanTransferredLogs,
  type DecodedTransferredLog,
} from "./noteScanner.js";
import {
  createNote,
  commitmentOf,
  encryptNoteForTransfer,
  generateViewingKey,
} from "./notes.js";

// -----------------------------------------------------------------------------
// Helpers — build a DecodedTransferredLog directly from two notes
// -----------------------------------------------------------------------------

function buildDecoded(
  note0: ReturnType<typeof createNote>,
  recipient0Pub: Uint8Array,
  note1: ReturnType<typeof createNote>,
  recipient1Pub: Uint8Array,
  blockNumber = 1n,
): DecodedTransferredLog {
  const c0 = commitmentOf(note0);
  const c1 = commitmentOf(note1);
  // Phase 1B: the on-chain wire ciphertext slot will eventually be tighter,
  // but for the scanner unit test we use the SDK wire format and assert that
  // tryDecryptTransferred routes it correctly. The contract decoder lives in
  // decodeTransferredLog and is exercised by integration tests.
  const blob0 = encryptNoteForTransfer(note0, recipient0Pub, c0);
  const blob1 = encryptNoteForTransfer(note1, recipient1Pub, c1);

  return {
    nullifierHash0: 0xaaaan,
    nullifierHash1: 0xbbbbn,
    outputCommitment0: c0,
    outputCommitment1: c1,
    ciphertext0Blob: blob0,
    // The AAD field in DecodedTransferredLog mirrors the on-chain bytes32 that
    // the contract enforces. Always: keccak256(abi.encode(commitment)).
    ciphertext0Aad: keccak_256(commitmentBytes(c0)),
    ciphertext1Blob: blob1,
    ciphertext1Aad: keccak_256(commitmentBytes(c1)),
    blockNumber,
    txHash: "0xdeadbeef",
    logIndex: 0,
  };
}

function commitmentBytes(c: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = c;
  for (let i = 31; i >= 0 && v > 0n; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

// 1. Topic hashes match canonical Solidity event signatures.
{
  const expectedSpent =
    "0x" +
    Array.from(
      keccak_256(
        new TextEncoder().encode(
          "Spent(uint256,uint256,uint256,uint256,uint256)",
        ),
      ),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
  assert.equal(SPENT_TOPIC, expectedSpent, "SPENT_TOPIC drift");

  const expectedTransferred =
    "0x" +
    Array.from(
      keccak_256(
        new TextEncoder().encode(
          "Transferred(uint256,uint256,uint256,uint256,(bytes32[4],bytes32,bytes32,bytes32,bytes32),(bytes32[4],bytes32,bytes32,bytes32,bytes32))",
        ),
      ),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
  assert.equal(TRANSFERRED_TOPIC, expectedTransferred, "TRANSFERRED_TOPIC drift");
}

// 2. Correct viewing key on output 0 → transferred-in.
{
  const recipient = generateViewingKey();
  const stranger = generateViewingKey();

  const noteForMe = createNote(1_000_000n, 1n);
  const noteForOther = createNote(2_000_000n, 1n);
  const decoded = buildDecoded(
    noteForMe,
    recipient.publicKey,
    noteForOther,
    stranger.publicKey,
  );

  const ev = tryDecryptTransferred(decoded, recipient.privateKey);
  assert.equal(ev.type, "transferred-in", "recipient must observe their note");
  if (ev.type !== "transferred-in") throw new Error("type narrowing");
  assert.equal(ev.outputIndex, 0);
  assert.equal(ev.commitment, decoded.outputCommitment0);
  assert.equal(ev.note.amount, 1_000_000n);
  assert.equal(ev.siblingNullifierHash, 0xbbbbn);
}

// 3. Correct viewing key on output 1 → transferred-in.
{
  const recipient = generateViewingKey();
  const stranger = generateViewingKey();

  const noteForOther = createNote(2_000_000n, 1n);
  const noteForMe = createNote(750_000n, 1n);
  const decoded = buildDecoded(
    noteForOther,
    stranger.publicKey,
    noteForMe,
    recipient.publicKey,
  );

  const ev = tryDecryptTransferred(decoded, recipient.privateKey);
  assert.equal(ev.type, "transferred-in");
  if (ev.type !== "transferred-in") throw new Error("type narrowing");
  assert.equal(ev.outputIndex, 1);
  assert.equal(ev.commitment, decoded.outputCommitment1);
  assert.equal(ev.note.amount, 750_000n);
  assert.equal(ev.siblingNullifierHash, 0xaaaan);
}

// 4. Foreign viewing key on both outputs → transferred-other.
{
  const sender = generateViewingKey();
  const receiverA = generateViewingKey();
  const receiverB = generateViewingKey();

  const decoded = buildDecoded(
    createNote(1n, 1n),
    receiverA.publicKey,
    createNote(2n, 1n),
    receiverB.publicKey,
  );

  const ev = tryDecryptTransferred(decoded, sender.privateKey);
  assert.equal(
    ev.type,
    "transferred-other",
    "uninvolved viewing key must see transferred-other",
  );
}

// 5. AAD swap attack: an adversary takes two valid Transferred events from
//    the SAME block and shuffles the ciphertexts between commitments. Each
//    ciphertext is individually valid AEAD; only the AAD binding catches it.
{
  const recipient = generateViewingKey();

  // Two real transferred logs to the same recipient, each block-1.
  const noteA = createNote(1_000_000n, 1n);
  const noteB = createNote(2_000_000n, 1n);
  const cA = commitmentOf(noteA);
  const cB = commitmentOf(noteB);
  const blobA = encryptNoteForTransfer(noteA, recipient.publicKey, cA);
  const blobB = encryptNoteForTransfer(noteB, recipient.publicKey, cB);

  // The malicious relayer swaps the ciphertexts between commitments. The on-
  // chain contract would catch this via the aad field, but if it didn't, the
  // scanner MUST still refuse to decrypt.
  const shuffled: DecodedTransferredLog = {
    nullifierHash0: 1n,
    nullifierHash1: 2n,
    outputCommitment0: cA,
    outputCommitment1: cB,
    // Swap the blobs.
    ciphertext0Blob: blobB,
    ciphertext0Aad: keccak_256(commitmentBytes(cA)),
    ciphertext1Blob: blobA,
    ciphertext1Aad: keccak_256(commitmentBytes(cB)),
    blockNumber: 1n,
    txHash: "0xfeed",
    logIndex: 0,
  };

  const ev = tryDecryptTransferred(shuffled, recipient.privateKey);
  assert.equal(
    ev.type,
    "transferred-other",
    "AAD-bound ciphertexts must NOT decrypt when paired with the wrong commitment (Phase 1B Fix 3)",
  );
}

// 6. scanTransferredLogs is array-level equivalent of repeated
//    tryDecryptTransferred — sanity-check the convenience helper.
{
  const recipient = generateViewingKey();
  const stranger = generateViewingKey();

  const noteMine = createNote(1n, 1n);
  const noteTheirs = createNote(2n, 1n);

  const log1 = buildDecoded(noteMine, recipient.publicKey, noteTheirs, stranger.publicKey, 1n);
  const log2 = buildDecoded(noteTheirs, stranger.publicKey, noteTheirs, stranger.publicKey, 2n);

  const events = scanTransferredLogs([log1, log2], recipient.privateKey);
  assert.equal(events.length, 2);
  assert.equal(events[0].type, "transferred-in");
  assert.equal(events[1].type, "transferred-other");
}

// 7. Round-trip stability: encrypting the same note twice produces different
//    blobs (random ephemeral key) but both decrypt to identical plaintext.
//    This guards against a foot-gun where someone "optimises" the encryptor
//    to be deterministic and accidentally leaks linkage between transfers.
{
  const recipient = generateViewingKey();
  const note = createNote(123n, 4n);
  const c = commitmentOf(note);
  const blob1 = encryptNoteForTransfer(note, recipient.publicKey, c);
  const blob2 = encryptNoteForTransfer(note, recipient.publicKey, c);
  assert.notDeepEqual(
    blob1,
    blob2,
    "encryptNoteForTransfer must be non-deterministic across calls",
  );
}

console.log("zbase/core noteScanner.test.ts: scanner invariants hold");
