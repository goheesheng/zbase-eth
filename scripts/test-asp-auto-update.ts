/**
 * Offline regression tests for the public deposit -> private ASP boundary.
 * No RPC, Redis, signer, secrets, or deployed endpoint is accessed.
 */

import assert from "node:assert/strict";
import {
  DEPOSITED_TOPIC,
  findPoolDeposits,
  isTransactionHash,
  transactionBlockAge,
  transactionConfirmations,
} from "../src/lib/deposit-confirmation.ts";
import { MemoryAspUpdateStateStore } from "../src/lib/asp-update-state.ts";
import { confirmDepositForAsp } from "../src/lib/asp-confirm-client.ts";

const POOL = "0x1111111111111111111111111111111111111111";
const SPOOF = "0x2222222222222222222222222222222222222222";
const DEPOSITOR = "0x3333333333333333333333333333333333333333";
const TX = `0x${"ab".repeat(32)}` as `0x${string}`;
const word = (value: bigint) => value.toString(16).padStart(64, "0");
const eventData = `0x${word(11n)}${word(22n)}${word(990_000n)}${word(33n)}`;
const depositorTopic = `0x${DEPOSITOR.slice(2).padStart(64, "0")}`;

let passed = 0;
async function test(name: string, run: () => void | Promise<void>) {
  await run();
  passed += 1;
  console.log(`  PASS: ${name}`);
}

await test("strict transaction-hash validation", () => {
  assert.equal(isTransactionHash(TX), true);
  assert.equal(isTransactionHash("0x1234"), false);
  assert.equal(isTransactionHash(123), false);
});

await test("confirmation count is inclusive and never negative", () => {
  assert.equal(transactionConfirmations(100n, 100n), 1n);
  assert.equal(transactionConfirmations(101n, 100n), 2n);
  assert.equal(transactionConfirmations(99n, 100n), 0n);
  assert.equal(transactionBlockAge(125n, 100n), 25n);
  assert.equal(transactionBlockAge(99n, 100n), 0n);
});

await test("same-topic event from an attacker contract is rejected", () => {
  const deposits = findPoolDeposits(
    [{ address: SPOOF, topics: [DEPOSITED_TOPIC, depositorTopic], data: eventData }],
    POOL,
  );
  assert.equal(deposits.length, 0);
});

await test("malformed and zero-value pool events are rejected", () => {
  const zeroValue = `0x${word(11n)}${word(22n)}${word(0n)}${word(33n)}`;
  const deposits = findPoolDeposits(
    [
      { address: POOL, topics: [DEPOSITED_TOPIC, depositorTopic], data: "0x12" },
      { address: POOL, topics: [DEPOSITED_TOPIC, depositorTopic], data: zeroValue },
    ],
    POOL,
  );
  assert.equal(deposits.length, 0);
});

await test("authentic pool event is decoded from on-chain fields", () => {
  const [deposit] = findPoolDeposits(
    [
      {
        address: POOL.toUpperCase(),
        topics: [DEPOSITED_TOPIC, depositorTopic],
        data: eventData,
        logIndex: 7,
      },
    ],
    POOL,
  );
  assert.ok(deposit);
  assert.equal(deposit.depositor.toLowerCase(), DEPOSITOR);
  assert.equal(deposit.commitment, 11n);
  assert.equal(deposit.label, 22n);
  assert.equal(deposit.value, 990_000n);
  assert.equal(deposit.precommitmentHash, 33n);
  assert.equal(deposit.logIndex, 7);
});

await test("processing lock is exclusive and owner-safe", async () => {
  const store = new MemoryAspUpdateStateStore();
  assert.equal(await store.acquireLock("eip155:8453", POOL, "worker-a"), true);
  assert.equal(await store.ownsLock("eip155:8453", POOL, "worker-a"), true);
  assert.equal(await store.acquireLock("eip155:8453", POOL, "worker-b"), false);
  await store.releaseLock("eip155:8453", POOL, "wrong-owner");
  assert.equal(await store.ownsLock("eip155:8453", POOL, "worker-a"), true);
  assert.equal(await store.acquireLock("eip155:8453", POOL, "worker-b"), false);
  await store.releaseLock("eip155:8453", POOL, "worker-a");
  assert.equal(await store.ownsLock("eip155:8453", POOL, "worker-a"), false);
  assert.equal(await store.acquireLock("eip155:8453", POOL, "worker-b"), true);
});

await test("terminal status is durably idempotent in the state store", async () => {
  const store = new MemoryAspUpdateStateStore();
  const now = new Date().toISOString();
  await store.put("eip155:8453", POOL, {
    txHash: TX,
    status: "included",
    root: "123",
    createdAt: now,
    updatedAt: now,
  });
  assert.deepEqual((await store.get("eip155:8453", POOL, TX))?.status, "included");

  const queued = await store.put("eip155:8453", POOL, {
    txHash: TX,
    status: "queued",
    reason: "late lock loser",
    createdAt: now,
    updatedAt: new Date(Date.now() + 1_000).toISOString(),
  });
  assert.equal(queued.status, "included");
  assert.equal((await store.get("eip155:8453", POOL, TX))?.status, "included");
});

await test("client checks non-2xx responses", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  try {
    await assert.rejects(
      confirmDepositForAsp(TX, { maxAttempts: 1 }),
      /unauthorized/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test("client retries queued work and stops at inclusion", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(
      JSON.stringify(
        calls === 1
          ? { txHash: TX, status: "queued", reason: "index lag" }
          : { txHash: TX, status: "included", root: "456" },
      ),
      { status: calls === 1 ? 202 : 200, headers: { "content-type": "application/json" } },
    );
  };
  try {
    const result = await confirmDepositForAsp(TX, {
      maxAttempts: 2,
      retryDelayMs: 0,
    });
    assert.equal(result.status, "included");
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

console.log(`\nASP AUTO-UPDATE: ${passed} checks passed`);
