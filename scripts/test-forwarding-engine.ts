/**
 * Fund-safety tests for the forwarding engine CORE (processPendingDeposits).
 *
 * The load-bearing invariants — a break in any one risks user funds or
 * double-spends:
 *   1. A FAILED deposit is NOT marked processed → retried next run, funds stay
 *      recoverable in the watched address (never lost).
 *   2. DEDUP: an already-processed id is never deposited again (no double-deposit
 *      of the same inbound).
 *   3. The index is advanced ONLY after a confirmed deposit (advance() is called
 *      exactly once per successful deposit, never on failure).
 *   4. BUDGET CAP refuses to exceed the per-run ceiling (runaway-key guard).
 *   5. Dust + unregistered addresses are skipped, not deposited.
 *
 * Run: npx tsx scripts/test-forwarding-engine.ts
 */

import * as assert from "node:assert/strict";
import {
  processPendingDeposits,
  type DepositAuthority,
  type PrecommitmentSource,
  type EngineState,
} from "../src/lib/forwarding-engine";
import type { PendingDeposit } from "../src/lib/forwarding-watcher";

let passed = 0;
async function ok(name: string, fn: () => Promise<void>) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const WATCHED = "0x3333333333333333333333333333333333333333" as const;

function pending(id: string, amount = 1_000_000n): PendingDeposit {
  return {
    id,
    payer: "0x1111111111111111111111111111111111111111",
    watchedAddress: WATCHED,
    amount,
    txHash: `0x${id.replace(/[^0-9a-f]/gi, "0").padEnd(64, "0")}` as `0x${string}`,
    blockNumber: 100n,
  };
}

function freshState(): EngineState {
  return { processedIds: new Set(), depositedPrecommitments: new Set(), spentThisRun: 0n };
}

// A mock authority that succeeds and records calls, or fails on demand.
function mockAuthority(opts?: { failOn?: Set<string>; failAll?: boolean }) {
  const calls: Array<{ amount: bigint; precommitment: string }> = [];
  const authority: DepositAuthority = {
    async deposit({ amount, precommitment }) {
      calls.push({ amount, precommitment });
      if (opts?.failAll) throw new Error("simulated deposit revert");
      return { txHash: `0x${"ab".repeat(32)}` as `0x${string}` };
    },
  };
  return { authority, calls };
}

// A source with a FIXED precommitment (models the current registry: one
// precommitment per address until the user re-registers). Used to exercise the
// reused-precommitment guard.
function mockSource(precommitment: string | null = "999") {
  const advances: `0x${string}`[] = [];
  const source: PrecommitmentSource = {
    async precommitmentFor() {
      return precommitment;
    },
    async advance(_addr, txHash) {
      advances.push(txHash);
    },
  };
  return { source, advances };
}

// A source that returns a UNIQUE precommitment per call (models the user
// registering a fresh slot between inbounds). Used where we want multiple
// deposits to succeed without tripping the reuse guard.
function uniqueSource() {
  const advances: `0x${string}`[] = [];
  let i = 0;
  const source: PrecommitmentSource = {
    async precommitmentFor() {
      i += 1;
      return `precommit-${i}`;
    },
    async advance(_addr, txHash) {
      advances.push(txHash);
    },
  };
  return { source, advances };
}

async function main() {
  console.log("forwarding-engine core — fund-safety invariants\n");

  await ok("happy path: clean deposit is deposited + index advanced ONCE", async () => {
    const { authority, calls } = mockAuthority();
    const { source, advances } = mockSource();
    const state = freshState();
    const res = await processPendingDeposits([pending("a:0")], authority, source, state);
    assert.equal(res.deposited.length, 1);
    assert.equal(calls.length, 1, "deposit called exactly once");
    assert.equal(advances.length, 1, "index advanced exactly once (after confirm)");
    assert.ok(state.processedIds.has("a:0"));
    assert.equal(state.spentThisRun, 1_000_000n);
  });

  await ok("INVARIANT 1: failed deposit is NOT marked processed (retryable, funds safe)", async () => {
    const { authority } = mockAuthority({ failAll: true });
    const { source, advances } = mockSource();
    const state = freshState();
    const res = await processPendingDeposits([pending("b:0")], authority, source, state);
    assert.equal(res.deposited.length, 0);
    assert.equal(res.failed.length, 1);
    assert.equal(state.processedIds.has("b:0"), false, "a failed deposit must remain retryable");
    assert.equal(advances.length, 0, "index must NOT advance on failure");
    assert.equal(state.spentThisRun, 0n, "no spend counted on failure");
  });

  await ok("INVARIANT 2: dedup — an already-processed id is never re-deposited", async () => {
    const { authority, calls } = mockAuthority();
    const { source } = mockSource();
    const state = freshState();
    state.processedIds.add("c:0");
    const res = await processPendingDeposits([pending("c:0")], authority, source, state);
    assert.equal(res.deposited.length, 0);
    assert.equal(calls.length, 0, "must NOT call deposit for an already-processed id");
    assert.equal(res.skipped[0]?.reason, "already-processed");
  });

  await ok("INVARIANT 2b: same batch twice does not double-deposit", async () => {
    const { authority, calls } = mockAuthority();
    const { source } = mockSource();
    const state = freshState();
    const batch = [pending("d:0")];
    await processPendingDeposits(batch, authority, source, state);
    await processPendingDeposits(batch, authority, source, state); // re-run
    assert.equal(calls.length, 1, "second run must skip the already-deposited id");
  });

  await ok("INVARIANT 4: budget cap refuses to exceed the per-run ceiling", async () => {
    const { authority, calls } = mockAuthority();
    const { source } = uniqueSource(); // distinct precommitments so the CAP is what stops #2, not the reuse guard
    const state = freshState();
    // Cap = 1.5 USDC; two 1-USDC deposits → only the first fits.
    const res = await processPendingDeposits(
      [pending("e:0", 1_000_000n), pending("e:1", 1_000_000n)],
      authority,
      source,
      state,
      { maxSpendAtomic: 1_500_000n },
    );
    assert.equal(res.deposited.length, 1, "only the first deposit fits under the cap");
    assert.equal(calls.length, 1);
    assert.equal(res.skipped.find((s) => s.id === "e:1")?.reason, "run-budget-exceeded");
  });

  await ok("INVARIANT 5: dust below min amount is skipped", async () => {
    const { authority, calls } = mockAuthority();
    const { source } = mockSource();
    const state = freshState();
    const res = await processPendingDeposits([pending("f:0", 100n)], authority, source, state, {
      minAmountAtomic: 1000n,
    });
    assert.equal(res.deposited.length, 0);
    assert.equal(calls.length, 0);
    assert.equal(res.skipped[0]?.reason, "below-min-amount");
  });

  await ok("unregistered watched address is skipped (not deposited)", async () => {
    const { authority, calls } = mockAuthority();
    const { source } = mockSource(null); // precommitmentFor → null
    const state = freshState();
    const res = await processPendingDeposits([pending("g:0")], authority, source, state);
    assert.equal(res.deposited.length, 0);
    assert.equal(calls.length, 0, "no deposit without a registered precommitment");
    assert.equal(res.skipped[0]?.reason, "not-registered");
  });

  await ok("mixed batch: one succeeds, one fails — only the success advances", async () => {
    // Fail the SECOND by using an authority that throws only on the 2nd call.
    let n = 0;
    const authority: DepositAuthority = {
      async deposit() {
        n += 1;
        if (n === 2) throw new Error("second reverts");
        return { txHash: `0x${"cd".repeat(32)}` as `0x${string}` };
      },
    };
    const { source, advances } = uniqueSource(); // distinct precommitments → tests the FAILURE path, not the reuse guard
    const state = freshState();
    const res = await processPendingDeposits(
      [pending("h:0"), pending("h:1")],
      authority,
      source,
      state,
    );
    assert.equal(res.deposited.length, 1);
    assert.equal(res.failed.length, 1);
    assert.equal(advances.length, 1, "only the successful deposit advances the index");
    assert.ok(state.processedIds.has("h:0"));
    assert.equal(state.processedIds.has("h:1"), false, "failed one stays retryable");
  });

  await ok("AUDIT HIGH: 2nd deposit at the SAME precommitment is REFUSED (fund-lock prevented)", async () => {
    // The registry gives ONE precommitment per address. Two inbounds to that
    // address before re-registration would deposit at the same precommitment →
    // same nullifier → the 2nd note is permanently unspendable. The guard must
    // deposit the FIRST and REFUSE the second (funds stay recoverable).
    const { authority, calls } = mockAuthority();
    const { source } = mockSource("shared-precommit"); // fixed → models the registry
    const state = freshState();
    const res = await processPendingDeposits(
      [pending("lock:0"), pending("lock:1")],
      authority,
      source,
      state,
    );
    assert.equal(res.deposited.length, 1, "only the first inbound is deposited");
    assert.equal(calls.length, 1, "deposit called exactly once — never twice at the same precommitment");
    const skip = res.skipped.find((s) => s.id === "lock:1");
    assert.ok(skip, "the second inbound must be skipped, not deposited");
    assert.match(skip!.reason, /precommitment-already-used/);
    assert.equal(state.processedIds.has("lock:1"), false, "skipped inbound stays retryable after re-registration");
  });

  await ok("after registering a FRESH precommitment, the held inbound deposits fine", async () => {
    const { authority, calls } = mockAuthority();
    const state = freshState();
    // First inbound at precommit A.
    await processPendingDeposits([pending("m:0")], authority, mockSource("A").source, state);
    // Second inbound — user has now registered a FRESH precommit B.
    const res = await processPendingDeposits([pending("m:1")], authority, mockSource("B").source, state);
    assert.equal(res.deposited.length, 1, "fresh precommitment lets the held inbound through");
    assert.equal(calls.length, 2);
  });

  console.log(`\n${passed} passed\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
