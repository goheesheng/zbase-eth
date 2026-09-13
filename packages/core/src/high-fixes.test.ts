/**
 * Regression tests for the SDK HIGH fixes (black-hat audit 2026-07-09):
 *   - deserializeNote range-validates amount + field elements
 *   - deriveViewingKeyFromSeed requires the exact 64-byte BIP39 seed
 *
 * Run: npx tsx src/high-fixes.test.ts  (from packages/core)
 */

import * as assert from "node:assert/strict";
import { deserializeNote, serializeNote, createNote, NoteValueError } from "./notes.js";
import { deriveViewingKeyFromSeed, deriveViewingKeyFromMnemonic } from "./viewingKeyHD.js";
import { mnemonicToSeedSync } from "@scure/bip39";

let passed = 0;
function ok(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log("SDK HIGH fixes — deserialize range + viewingKey seed guard\n");

// ── deserializeNote range validation ────────────────────────────────────────
ok("deserializeNote rejects amount >= 2^64", () => {
  const bad = JSON.stringify({ amount: (2n ** 300n).toString(), label: "1", nullifier: "1", secret: "1" });
  assert.throws(() => deserializeNote(bad), NoteValueError);
});

ok("deserializeNote rejects negative amount", () => {
  const bad = JSON.stringify({ amount: "-5", label: "1", nullifier: "1", secret: "1" });
  assert.throws(() => deserializeNote(bad), NoteValueError);
});

ok("deserializeNote rejects out-of-field nullifier/secret/label", () => {
  const big = (2n ** 255n).toString();
  assert.throws(() => deserializeNote(JSON.stringify({ amount: "100", label: "1", nullifier: big, secret: "1" })), NoteValueError);
  assert.throws(() => deserializeNote(JSON.stringify({ amount: "100", label: "1", nullifier: "1", secret: big })), NoteValueError);
  assert.throws(() => deserializeNote(JSON.stringify({ amount: "100", label: big, nullifier: "1", secret: "1" })), NoteValueError);
});

ok("deserializeNote accepts a valid note (round-trip)", () => {
  const n = createNote(1000n, 5n);
  const back = deserializeNote(serializeNote(n));
  assert.equal(back.amount, n.amount);
  assert.equal(back.nullifier, n.nullifier);
});

// ── deriveViewingKeyFromSeed 64-byte guard ──────────────────────────────────
const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

ok("rejects a 32-byte seed (would derive the WRONG key vs mnemonic path)", () => {
  assert.throws(() => deriveViewingKeyFromSeed(new Uint8Array(32)), /64-byte/);
});

ok("accepts the exact 64-byte BIP39 seed", () => {
  assert.doesNotThrow(() => deriveViewingKeyFromSeed(mnemonicToSeedSync(MNEMONIC)));
});

ok("64-byte-seed path matches the mnemonic path (recovery consistency)", () => {
  const fromSeed = deriveViewingKeyFromSeed(mnemonicToSeedSync(MNEMONIC));
  const fromMnemonic = deriveViewingKeyFromMnemonic(MNEMONIC);
  assert.deepEqual(fromSeed.publicKey, fromMnemonic.publicKey, "the two recovery paths must derive the same key");
});

console.log(`\n${passed} passed\n`);
