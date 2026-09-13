/**
 * walletBalance.test.ts — balance from a seed phrase alone.
 *
 * The acceptance test is #1: wipe everything, keep only 12 words, get the money
 * back. That is the difference between a wallet and a bag of secrets you must
 * never drop — and dropping one cost 0.985 USDC on 2026-07-16.
 *
 * Run: npx tsx packages/core/src/walletBalance.test.ts
 */
import * as assert from "node:assert/strict";
import { getWalletBalance, selectNote } from "./walletBalance.js";
import { deriveForwardingNote, generateNewMnemonic } from "./index.js";
import { computeCommitment, computeNullifierHash } from "./account.js";

let failed = false;
const ok = (m: string) => console.log("  PASS: " + m);
const bad = (m: string) => { console.log("  FAIL: " + m); failed = true; };

console.log("wallet balance — recover from a seed phrase\n");

const mnemonic = generateNewMnemonic();
const LABEL = "987654321";

/** Simulate the pool's Deposited event for a seed-derived note at `index`. */
const depositEvent = (index: number, value: string) => {
  const n = deriveForwardingNote(mnemonic, index);
  return { commitment: computeCommitment(value, LABEL, n.precommitment), label: LABEL, value };
};

const nothingSpent = async () => false;

// 1. THE ACCEPTANCE TEST. Only the seed survives. Everything else is gone.
{
  const events = [depositEvent(0, "1000000"), depositEvent(1, "500000"), depositEvent(2, "250000")];
  const bal = await getWalletBalance({ mnemonic, depositedEvents: events, isSpent: nothingSpent, maxIndex: 10 });
  assert.equal(bal.atomic, 1_750_000n);
  ok("seed + chain events => full balance rebuilt (no note file, no vault, no localStorage)");
  bal.spendable.length === 3 ? ok("all three notes recovered") : bad(`recovered ${bal.spendable.length}/3`);
  bal.highestFoundIndex === 2 ? ok("highestFoundIndex tracks the scan frontier") : bad("highestFoundIndex: " + bal.highestFoundIndex);
}

// 2. Chain truth beats local state. A restored wallet has NO local `withdrawn`
//    flag, so an already-spent note must be excluded by asking the pool — else the
//    wallet reports money it cannot spend.
{
  const events = [depositEvent(0, "1000000"), depositEvent(1, "500000")];
  const spentNote = deriveForwardingNote(mnemonic, 0);
  const spentHash = computeNullifierHash(spentNote.nullifier);
  const bal = await getWalletBalance({
    mnemonic,
    depositedEvents: events,
    isSpent: async (h) => h === spentHash,
    maxIndex: 10,
  });
  assert.equal(bal.atomic, 500_000n);
  ok("spent notes excluded via on-chain nullifierHashes (not a local flag)");
  bal.spent.length === 1 && bal.spent[0].index === 0 ? ok("spent notes still reported, for history") : bad("spent tracking");
}

// 3. Gaps must not truncate recovery — a deposit that never confirmed leaves a
//    hole, and stopping at it would silently hide every later note.
{
  const events = [depositEvent(0, "100000"), depositEvent(7, "900000")]; // index 1-6 missing
  const bal = await getWalletBalance({ mnemonic, depositedEvents: events, isSpent: nothingSpent, maxIndex: 10 });
  assert.equal(bal.atomic, 1_000_000n);
  ok("scans past gaps (an unconfirmed deposit doesn't hide later notes)");
}

// 4. maxIndex bounds the scan — notes beyond the window are NOT found. This is the
//    sharp edge of the design and worth asserting so nobody assumes otherwise.
{
  const events = [depositEvent(60, "1000000")];
  const bal = await getWalletBalance({ mnemonic, depositedEvents: events, isSpent: nothingSpent, maxIndex: 50 });
  assert.equal(bal.atomic, 0n);
  ok("a note beyond maxIndex is NOT recovered (scan window is a real limit)");
  const wider = await getWalletBalance({ mnemonic, depositedEvents: events, isSpent: nothingSpent, maxIndex: 64 });
  assert.equal(wider.atomic, 1_000_000n);
  ok("widening maxIndex finds it");
}

// 5. Foreign notes are ignored — someone else's deposits are not your balance.
{
  const other = generateNewMnemonic();
  const otherNote = deriveForwardingNote(other, 0);
  const events = [
    depositEvent(0, "100000"),
    { commitment: computeCommitment("999000000", LABEL, otherNote.precommitment), label: LABEL, value: "999000000" },
  ];
  const bal = await getWalletBalance({ mnemonic, depositedEvents: events, isSpent: nothingSpent, maxIndex: 10 });
  assert.equal(bal.atomic, 100_000n);
  ok("another seed's notes are not counted");
}

// 6. Empty wallet.
{
  const bal = await getWalletBalance({ mnemonic, depositedEvents: [], isSpent: nothingSpent, maxIndex: 10 });
  assert.equal(bal.atomic, 0n);
  bal.highestFoundIndex === -1 ? ok("empty wallet => 0 balance, index -1") : bad("empty wallet");
}

// 7. selectNote: the pool spends ONE note per withdrawal, so "total is enough" is
//    NOT the same as "payable". This is the trap the SDK's generic
//    "insufficient balance" error hides.
{
  const events = [depositEvent(0, "100000"), depositEvent(1, "100000")];
  const bal = await getWalletBalance({ mnemonic, depositedEvents: events, isSpent: nothingSpent, maxIndex: 10 });
  assert.equal(bal.atomic, 200_000n);

  const fits = selectNote(bal, 50_000n);
  fits && BigInt(fits.value) === 100_000n ? ok("selectNote picks a note that covers the price") : bad("selectNote miss");

  const none = selectNote(bal, 150_000n);
  none === null
    ? ok("balance 200k but NO single note covers 150k => null (one note per withdrawal)")
    : bad("selectNote wrongly returned a note that cannot cover the amount");
}

// 8. selectNote prefers the smallest sufficient note — keep big notes whole.
{
  const events = [depositEvent(0, "1000000"), depositEvent(1, "60000"), depositEvent(2, "300000")];
  const bal = await getWalletBalance({ mnemonic, depositedEvents: events, isSpent: nothingSpent, maxIndex: 10 });
  const pick = selectNote(bal, 50_000n);
  pick && BigInt(pick.value) === 60_000n ? ok("smallest sufficient note chosen (big notes stay intact)") : bad("picked " + pick?.value);
}

console.log(failed ? "\nFAILED" : "\nWALLET BALANCE: a seed phrase is enough");
process.exit(failed ? 1 : 0);
