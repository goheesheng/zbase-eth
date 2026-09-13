/**
 * test-anonymity-count.ts — the anonymity set must count PARTICIPANTS, not leaves.
 *
 * Regression test for the measurement that defeated its own gate:
 * facilitator-readiness set `anonymitySet = Number(currentTreeSize)` — tree leaves,
 * which include treasury seeds AND change notes. Live consequence: the pool reported
 * anonymitySet:2 from ONE deposit, because a canary's own change note counted as
 * anonymity. And 30 treasury deposits would have flipped customerReady:true with zero
 * independent depositors, making /supported announce privacy that did not exist.
 *
 * Run: npx tsx scripts/test-anonymity-count.ts
 */
import * as assert from "node:assert/strict";
import {
  countAnonymitySet,
  countableFloorAtomic,
  MIN_COUNTABLE_DEPOSIT_ATOMIC,
} from "../src/lib/anonymity-count";

let failed = false;
const ok = (m: string) => console.log("  PASS: " + m);
const bad = (m: string) => { console.log("  FAIL: " + m); failed = true; };

const TREASURY = "0xfEbC47781B32d3c36A94674CF822Bc469dbbF378" as const;
const ALICE = "0xDbAA23601A95a01ee9B90160F6aA784CBE4E0f21" as const;
const BOB = "0x000000000000000000000000000000000000bEEF" as const;
const ONE = MIN_COUNTABLE_DEPOSIT_ATOMIC;

console.log("anonymity count — participants, not leaves\n");

// 1. THE CORE: you cannot hide from yourself.
{
  const c = countAnonymitySet(
    Array.from({ length: 30 }, () => ({ depositor: TREASURY, value: ONE })),
    TREASURY,
  );
  c.organic === 0
    ? ok("30 TREASURY deposits => organic 0 (would have flipped customerReady before)")
    : bad(`treasury counted as organic: ${c.organic}`);
  c.seeded === 30 ? ok("...still reported as seeded, not hidden") : bad("seeded: " + c.seeded);
}

// 2. Zero-value spam is not a participant. With minimumDepositAmount at 0 on-chain,
//    this is free and unlimited.
{
  const c = countAnonymitySet(
    [
      ...Array.from({ length: 100 }, () => ({ depositor: BOB, value: 0n })),
      { depositor: ALICE, value: ONE },
    ],
    TREASURY,
  );
  c.organic === 1 ? ok("100 zero-value spam deposits => organic 1 (spam excluded)") : bad("organic: " + c.organic);
  c.dust === 100 ? ok("...counted as dust, so the exclusion is visible not silent") : bad("dust: " + c.dust);
}

// 3. Below the floor is dust — $0.50 is not a participant.
{
  const c = countAnonymitySet([{ depositor: ALICE, value: 500_000n }], TREASURY);
  c.organic === 0 ? ok("a $0.50 deposit is dust, not anonymity") : bad("organic: " + c.organic);
}

// 4. distinctDepositors: one party making many deposits is ONE participant.
{
  const c = countAnonymitySet(
    Array.from({ length: 30 }, () => ({ depositor: ALICE, value: ONE })),
    TREASURY,
  );
  c.organic === 30 ? ok("30 deposits from one party => organic 30") : bad("organic: " + c.organic);
  c.distinctDepositors === 1
    ? ok("...but distinctDepositors 1 — the number that tells the truth")
    : bad("distinctDepositors: " + c.distinctDepositors);
}

// 5. A real set.
{
  const c = countAnonymitySet(
    [
      { depositor: ALICE, value: ONE },
      { depositor: BOB, value: 5_000_000n },
      { depositor: TREASURY, value: ONE },
      { depositor: BOB, value: 0n },
    ],
    TREASURY,
  );
  assert.equal(c.organic, 2);
  assert.equal(c.seeded, 1);
  assert.equal(c.dust, 1);
  assert.equal(c.distinctDepositors, 2);
  ok("mixed pool tallies correctly (2 organic / 1 seeded / 1 dust / 2 distinct)");
}

// 6. THE FEE TRAP. Entrypoint.sol:329 checks the minimum against the PRE-fee amount, but
//    the Deposited event carries the POST-fee value. A $1.00 deposit at 100 BPS emits
//    990_000. A floor of 1_000_000 would reject every legitimate minimum deposit as dust
//    and report an empty set while real people were depositing.
{
  const floor = countableFloorAtomic(1_000_000n, 100n);
  floor === 990_000n ? ok("floor derives post-fee: $1 @ 100bps => 990_000") : bad("floor: " + floor);

  const c = countAnonymitySet([{ depositor: ALICE, value: 990_000n }], TREASURY, floor);
  c.organic === 1 ? ok("a minimum-sized $1 deposit COUNTS (post-fee 990_000 >= floor)") : bad("organic: " + c.organic);

  // The bug this guards: comparing the event value to the raw on-chain minimum.
  const naive = countAnonymitySet([{ depositor: ALICE, value: 990_000n }], TREASURY, 1_000_000n);
  naive.organic === 0
    ? ok("...and the naive pre-fee floor WOULD have rejected it (the trap, demonstrated)")
    : bad("naive floor unexpectedly counted it");
}

// 6b. Unarmed minimum (today: on-chain minimum is 0) => reject only literal zero-value.
{
  const floor = countableFloorAtomic(0n, 100n);
  floor === 1n ? ok("minimum unarmed => floor 1 (still excludes free zero-value spam)") : bad("floor: " + floor);
  const c = countAnonymitySet([{ depositor: ALICE, value: 990_000n }, { depositor: BOB, value: 0n }], TREASURY, floor);
  c.organic === 1 && c.dust === 1 ? ok("...real deposit counts, zero-value does not") : bad("organic/dust");
}

// 6c. TODAY'S LIVE POOL, honestly. One $0.99 Deposited + one change note. The change note
//     is a LeafInserted, never a Deposited, so it cannot reach this function — which is
//     the whole fix. currentTreeSize said 2; the truth is 1.
{
  const c = countAnonymitySet([{ depositor: ALICE, value: 990_000n }], TREASURY);
  c.organic === 1 ? ok("live pool: ONE participant, not 2 (change note cannot be counted)") : bad("organic: " + c.organic);
  c.distinctDepositors === 1 ? ok("...1 distinct depositor — 29 short of the gate") : bad("distinct");
}

// 7. No treasury configured => nothing is seeded (don't silently drop real deposits).
{
  const c = countAnonymitySet([{ depositor: ALICE, value: ONE }], null);
  c.organic === 1 && c.seeded === 0 ? ok("null treasury => all real deposits count as organic") : bad("null-treasury handling");
}

// 8. THE WIRING. Every test above checks countAnonymitySet in isolation, and every test
//    in test-anonymity-gate.ts feeds `organicAnonymitySet` in as a number. Neither can see
//    WHICH field readiness actually reads — and that seam is where the bug lived: it wired
//    `.organic` (deposits) into a gate whose message says "independent depositor(s)".
//
//    A whole-number test cannot catch a wrong-field bug, so this asserts the contract the
//    two sides must agree on: for the gate to mean what it says, the number it consumes
//    must be the one that does NOT move when one party deposits again.
{
  const oneWhale = Array.from({ length: 30 }, () => ({ depositor: ALICE, value: ONE }));
  const c = countAnonymitySet(oneWhale, TREASURY);

  // The field readiness must NOT use: it reads 30 for a crowd of one.
  c.organic === 30 ? ok("one party x30 deposits => organic 30 (the trap field)") : bad("organic: " + c.organic);

  // The field readiness MUST use: it tells the truth.
  c.distinctDepositors === 1
    ? ok("...=> distinctDepositors 1 — the only field that survives a whale")
    : bad("distinctDepositors: " + c.distinctDepositors);

  // A gate on the wrong field would have OPENED here (30 >= 30) with one participant.
  const MIN = 30;
  c.organic >= MIN && c.distinctDepositors < MIN
    ? ok("...and a gate on organic would have flipped customerReady with ONE real depositor")
    : bad("the trap no longer reproduces — this test has stopped asserting anything");

  // 30 real people: both fields agree, so the honest field does not over-block.
  const crowd = Array.from({ length: 30 }, (_, i) => ({
    depositor: `0x${(i + 1).toString(16).padStart(40, "0")}` as `0x${string}`,
    value: ONE,
  }));
  const real = countAnonymitySet(crowd, TREASURY);
  real.distinctDepositors === 30
    ? ok("30 DISTINCT depositors => distinctDepositors 30 (a real crowd still passes)")
    : bad("distinctDepositors: " + real.distinctDepositors);

  // Mixed: a whale plus a few real people counts the people, not the notes.
  const mixed = countAnonymitySet(
    [...Array.from({ length: 50 }, () => ({ depositor: ALICE, value: ONE })),
     { depositor: BOB, value: ONE }],
    TREASURY,
  );
  mixed.distinctDepositors === 2
    ? ok("whale(50) + Bob(1) => 2 people, not 51 (extra notes buy the whale no anonymity)")
    : bad("distinctDepositors: " + mixed.distinctDepositors);
}

console.log(failed ? "\nFAILED" : "\nANONYMITY COUNT: measures participants, not leaves");
process.exit(failed ? 1 : 0);
