/**
 * Compliance-invariant tests for the forwarding InboundWatcher.
 *
 * The load-bearing property: a TAINTED payer's inbound transfer is QUARANTINED and
 * NEVER auto-deposited, while a CLEAN payer's is queued. If this breaks, the
 * forwarding rail becomes an easier illicit-funds on-ramp than v1 — the exact
 * thing the inbound-screening invariant exists to prevent.
 *
 * Run: npx tsx scripts/test-forwarding-watcher.ts
 */

import * as assert from "node:assert/strict";
import {
  screenInbound,
  decodeInboundTransfer,
  TRANSFER_TOPIC,
  type InboundTransfer,
} from "../src/lib/forwarding-watcher";
import type { SanctionsProvider, ReasonCode } from "../src/lib/ofac-screening";

let passed = 0;
async function ok(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// A mock provider that marks one specific address as sanctioned.
function mockProvider(taintedAddr: string): SanctionsProvider {
  const tainted = taintedAddr.toLowerCase();
  return {
    snapshotVersion: "test-snapshot-v1",
    isSanctioned: async (a) => a.toLowerCase() === tainted,
    reasonFor: (a): ReasonCode | null =>
      a.toLowerCase() === tainted ? ("ofac-sdn-direct" as ReasonCode) : null,
  };
}

const CLEAN_PAYER = "0x1111111111111111111111111111111111111111" as const;
const TAINTED_PAYER = "0x2222222222222222222222222222222222222222" as const;
const WATCHED = "0x3333333333333333333333333333333333333333" as const;

function inbound(
  payer: `0x${string}`,
  txHash: string,
  logIndex: number,
  amount = 1_000_000n,
): InboundTransfer {
  return {
    payer,
    watchedAddress: WATCHED,
    amount,
    txHash: txHash as `0x${string}`,
    blockNumber: 100n,
    logIndex,
  };
}

async function main() {
  console.log("forwarding-watcher — compliance invariants\n");

  await ok("CLEAN payer → pending (queued for auto-deposit)", async () => {
    const res = await screenInbound([inbound(CLEAN_PAYER, "0xaaa", 0)], {
      provider: mockProvider(TAINTED_PAYER),
    });
    assert.equal(res.pending.length, 1);
    assert.equal(res.quarantined.length, 0);
    assert.equal(res.pending[0].payer, CLEAN_PAYER);
  });

  await ok("TAINTED payer → quarantined, NEVER queued (the core invariant)", async () => {
    const res = await screenInbound([inbound(TAINTED_PAYER, "0xbbb", 0)], {
      provider: mockProvider(TAINTED_PAYER),
    });
    assert.equal(res.pending.length, 0, "tainted funds must NOT be queued for deposit");
    assert.equal(res.quarantined.length, 1);
    assert.equal(res.quarantined[0].reasonCode, "ofac-sdn-direct");
  });

  await ok("mixed batch splits clean/tainted correctly", async () => {
    const res = await screenInbound(
      [
        inbound(CLEAN_PAYER, "0xccc", 0),
        inbound(TAINTED_PAYER, "0xccc", 1),
        inbound(CLEAN_PAYER, "0xddd", 0),
      ],
      { provider: mockProvider(TAINTED_PAYER) },
    );
    assert.equal(res.pending.length, 2);
    assert.equal(res.quarantined.length, 1);
    assert.equal(res.screened, 3);
  });

  await ok("dedup: already-seen ids are skipped (re-org/overlap safe)", async () => {
    const seen = new Set(["0xeee:0"]);
    const res = await screenInbound(
      [inbound(CLEAN_PAYER, "0xeee", 0), inbound(CLEAN_PAYER, "0xeee", 1)],
      { provider: mockProvider(TAINTED_PAYER), seenIds: seen },
    );
    // First (0xeee:0) is already seen → skipped; only 0xeee:1 is processed.
    assert.equal(res.screened, 1);
    assert.equal(res.pending.length, 1);
    assert.equal(res.pending[0].id, "0xeee:1");
  });

  await ok("zero-amount transfer is ignored by decode", () => {
    const zeroData = "0x" + "0".repeat(64);
    const decoded = decodeInboundTransfer(
      {
        topics: [TRANSFER_TOPIC, pad(CLEAN_PAYER), pad(WATCHED)],
        data: zeroData,
        transactionHash: "0xfff",
        blockNumber: 1n,
        logIndex: 0,
      },
      new Set([WATCHED.toLowerCase()]),
    );
    assert.equal(decoded, null);
  });

  await ok("decode keeps only transfers to a watched address", () => {
    const amount = "0x" + (1_000_000n).toString(16).padStart(64, "0");
    const unwatched = "0x9999999999999999999999999999999999999999";
    const toUnwatched = decodeInboundTransfer(
      {
        topics: [TRANSFER_TOPIC, pad(CLEAN_PAYER), pad(unwatched)],
        data: amount,
        transactionHash: "0x111",
        blockNumber: 1n,
        logIndex: 0,
      },
      new Set([WATCHED.toLowerCase()]),
    );
    assert.equal(toUnwatched, null, "transfer to a non-watched address must be ignored");

    const toWatched = decodeInboundTransfer(
      {
        topics: [TRANSFER_TOPIC, pad(CLEAN_PAYER), pad(WATCHED)],
        data: amount,
        transactionHash: "0x222",
        blockNumber: 1n,
        logIndex: 0,
      },
      new Set([WATCHED.toLowerCase()]),
    );
    assert.ok(toWatched, "transfer to a watched address must decode");
    assert.equal(toWatched!.payer.toLowerCase(), CLEAN_PAYER.toLowerCase());
    assert.equal(toWatched!.amount, 1_000_000n);
  });

  console.log(`\n${passed} passed\n`);
}

/** Left-pad a 20-byte address to a 32-byte topic word. */
function pad(addr: string): string {
  return "0x" + "0".repeat(24) + addr.slice(2).toLowerCase();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
