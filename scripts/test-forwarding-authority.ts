/**
 * Tests for the B1 DepositAuthority (src/lib/forwarding-authority.ts).
 *
 * Two groups:
 *
 * 1. Deposit call building — correct (asset, amount, precommitment) args against
 *    the ACTIVE stack, and a REFUSAL against an un-provisioned stack (0x0
 *    addresses). The 0x0-guard prevents the --live daemon from depositing into a
 *    non-existent mainnet pool before MAINNET_STACK is wired.
 *
 * 2. Treasury safety (regression, 2026-07-16) — NO SWEEP, NO DEPOSIT.
 *    createB1DepositAuthority used to destructure `watchedAddress` away and call
 *    Entrypoint.deposit() from the postman. deposit() pulls from msg.sender
 *    (Entrypoint.sol:123), so that spent the POSTMAN's own USDC while the user's
 *    funds sat untouched in their own address, and recorded the postman as
 *    depositors[_label] — permanently disabling ragequit on the note
 *    (PrivacyPool.sol:132-135). Bounded only by ZBASE_FORWARDING_MAX_SPEND_USDC
 *    ($50 default), which reads like a sizing knob, not a last line of defence.
 *
 * Run: npx tsx scripts/test-forwarding-authority.ts
 *   (defaults to the Sepolia stack, which IS provisioned → the call builds.)
 */

import * as assert from "node:assert/strict";
import {
  buildDepositCall,
  DEPOSIT_ERC20_ABI,
  createB1DepositAuthority,
  ForwardingSweepMissingError,
} from "../src/lib/forwarding-authority";
import { encodeBatchCalls, type PostmanCall } from "../src/lib/postman-signer";
import { getActiveStack } from "../src/lib/contracts";

let passed = 0;
function ok(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}
async function okAsync(name: string, fn: () => Promise<void>) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log("forwarding-authority — deposit call building\n");

const stack = getActiveStack();
const provisioned =
  stack.entrypoint &&
  !/^0x0{40}$/i.test(stack.entrypoint) &&
  stack.usdc &&
  !/^0x0{40}$/i.test(stack.usdc) &&
  stack.usdcPool &&
  !/^0x0{40}$/i.test(stack.usdcPool);

if (provisioned) {
  ok("builds a deposit call with correct args on a provisioned stack", () => {
    const call = buildDepositCall({ amount: 990_000n, precommitment: "12345" });
    assert.equal(call.address, stack.entrypoint, "targets the Entrypoint");
    assert.equal(call.functionName, "deposit");
    assert.equal(call.abi, DEPOSIT_ERC20_ABI);
    // args = [USDC asset, amount, precommitment as bigint]
    assert.equal(call.args[0], stack.usdc, "asset = USDC");
    assert.equal(call.args[1], 990_000n, "amount preserved");
    assert.equal(call.args[2], 12345n, "precommitment coerced to bigint");
    assert.equal(call.gas, 1_000_000n, "gas hint matches decoy-scheduler deposit");
  });

  ok("precommitment string is coerced to bigint exactly", () => {
    const big = "21888242871839275222246405745257275088548364400416034343698204186575808495616";
    const call = buildDepositCall({ amount: 1n, precommitment: big });
    assert.equal(call.args[2], BigInt(big));
  });
} else {
  // If the active stack is mainnet-unprovisioned, the guard must fire.
  ok("REFUSES to build a deposit against an un-provisioned (0x0) stack", () => {
    assert.throws(
      () => buildDepositCall({ amount: 1n, precommitment: "1" }),
      /un-provisioned|0x0|provision/i,
      "must refuse to deposit into a non-existent pool",
    );
  });
}

// ── Treasury safety: NO SWEEP, NO DEPOSIT ───────────────────────────────────
console.log("\nforwarding-authority — treasury safety (regression 2026-07-16)\n");

const WATCHED = "0xDbAA23601A95a01ee9B90160F6aA784CBE4E0f21" as const;
const PRE = "12345";
const deposit = (a: ReturnType<typeof createB1DepositAuthority>) =>
  a.deposit({ watchedAddress: WATCHED, amount: 1_000_000n, precommitment: PRE });

// THE regression: the old code took no sweeper and deposited anyway.
await okAsync("no sweeper => REFUSES (never spends the postman's own USDC)", async () => {
  await assert.rejects(
    () => deposit(createB1DepositAuthority()),
    (e: Error) => e instanceof ForwardingSweepMissingError,
  );
});

await okAsync("zero-deposit sweep => REFUSES (no treasury top-up)", async () => {
  await assert.rejects(
    () =>
      deposit(
        createB1DepositAuthority({
          // Builds no move and a zero deposit — the authority must refuse rather than
          // deposit the postman's own USDC in the user's place.
          buildSweepCalls: async () => ({ calls: [], depositAtomic: 0n }),
        }),
      ),
    /moved 0 atomic USDC/,
  );
});

// The sweep must receive the watched address — the exact argument the bug dropped.
await okAsync("sweep receives watchedAddress + amount, and runs BEFORE any deposit", async () => {
  let sawWatched: string | undefined;
  let sawAmount: bigint | undefined;
  await assert.rejects(
    () =>
      deposit(
        createB1DepositAuthority({
          buildSweepCalls: async ({ watchedAddress, amount }) => {
            sawWatched = watchedAddress;
            sawAmount = amount;
            throw new Error("stop-before-chain");
          },
        }),
      ),
    /stop-before-chain/,
  );
  assert.equal(sawWatched, WATCHED, "watchedAddress reached the sweep");
  assert.equal(sawAmount, 1_000_000n, "inbound amount reached the sweep");
});

// Atomic composition (regression 2026-07-19): a positive deposit must append the
// deposit call to the sweep's calls and hand them to the postman as ONE batch — not
// send the sweep, then separately send the deposit (the cross-userOp race that
// stranded funds). We can't send here (no signer configured), so we assert the
// authority reached the batch submitter AFTER building both parts.
await okAsync("positive deposit => builds sweep calls + deposit, submits as one batch", async () => {
  let builtCalls = 0;
  await assert.rejects(
    () =>
      deposit(
        createB1DepositAuthority({
          buildSweepCalls: async () => {
            builtCalls += 1;
            return {
              // A single sentinel receive call; the authority appends the deposit.
              calls: [
                { address: WATCHED, abi: [], functionName: "receiveWithAuthorization", args: [] },
              ],
              depositAtomic: 1_000_000n,
            };
          },
        }),
      ),
    // Reaches sendPostmanBatch → assertPostmanSignerLaunchReady throws on the missing
    // signer config. That it got here proves the deposit was composed, not that the
    // sweep was sent on its own.
    /POSTMAN|CDP|signer|PRIVATE_KEY/i,
  );
  assert.equal(builtCalls, 1, "buildSweepCalls ran exactly once before the batched send");
});

// ── Batch ordering (regression 2026-07-19): the atomic userOp must carry the calls
//    in [receive, approve?, deposit] order — a later call depends on an earlier one's
//    state (deposit needs the approve's allowance + the receive's balance). Encoding
//    is the point where a reorder would silently break atomicity, so pin it directly.
console.log("\nforwarding-authority — atomic batch encoding (regression 2026-07-19)\n");

const A_RECEIVE = "0x1111111111111111111111111111111111111111" as const;
const A_APPROVE = "0x2222222222222222222222222222222222222222" as const;
const A_DEPOSIT = "0x3333333333333333333333333333333333333333" as const;
const noArgAbi = (name: string) =>
  [{ type: "function", name, inputs: [], outputs: [], stateMutability: "nonpayable" }] as const;

ok("encodeBatchCalls preserves [receive, approve, deposit] order, all value 0", () => {
  const batch: PostmanCall[] = [
    { address: A_RECEIVE, abi: noArgAbi("receiveWithAuthorization") as never, functionName: "receiveWithAuthorization", args: [] },
    { address: A_APPROVE, abi: noArgAbi("approve") as never, functionName: "approve", args: [] },
    { address: A_DEPOSIT, abi: noArgAbi("deposit") as never, functionName: "deposit", args: [] },
  ];
  const encoded = encodeBatchCalls(batch);
  assert.equal(encoded.length, 3, "all three calls encoded — none dropped");
  assert.deepEqual(
    encoded.map((c) => c.to),
    [A_RECEIVE, A_APPROVE, A_DEPOSIT],
    "order preserved: receive → approve → deposit",
  );
  assert.equal(encoded[encoded.length - 1].to, A_DEPOSIT, "deposit is LAST (spends prior calls' state)");
  assert.ok(encoded.every((c) => c.value === 0n), "no ETH value on any call (USDC-only, sponsored gas)");
});

ok("encodeBatchCalls handles the no-approve case (allowance already sufficient)", () => {
  const encoded = encodeBatchCalls([
    { address: A_RECEIVE, abi: noArgAbi("receiveWithAuthorization") as never, functionName: "receiveWithAuthorization", args: [] },
    { address: A_DEPOSIT, abi: noArgAbi("deposit") as never, functionName: "deposit", args: [] },
  ]);
  assert.equal(encoded.length, 2, "receive + deposit only");
  assert.equal(encoded[encoded.length - 1].to, A_DEPOSIT, "deposit still last");
});

console.log(`\n${passed} passed\n`);
