/**
 * Authorization tests for /api/forwarding/register (fixes the CRITICAL
 * unauth-takeover flagged in the 2026-07-09 commit security review).
 *
 * Watched addresses are PUBLIC. Without auth, anyone could overwrite a victim's
 * precommitment with their own → the engine deposits the victim's inbound funds
 * at a commitment the ATTACKER's seed can spend (fund theft). The fix: every
 * register/update must be signed by the watchedAddress key over the exact
 * (address, precommitment, nextIndex). These tests prove:
 *   - a valid signature by the address key verifies,
 *   - a signature by a DIFFERENT key is rejected (the takeover attempt),
 *   - tampering any field (precommitment / index) invalidates the signature.
 *
 * Run: npx tsx scripts/test-forwarding-authz.ts
 */

import * as assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { verifyMessage } from "viem";
import { registrationMessage } from "../src/app/api/forwarding/register/route";

let passed = 0;
async function ok(name: string, fn: () => Promise<void>) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// Two independent keys: the legit owner of the watched address, and an attacker.
const owner = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const attacker = privateKeyToAccount(
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
);

const PRECOMMITMENT = "12345678901234567890";
const NEXT_INDEX = 0;
const NETWORK = "sepolia";

async function main() {
  console.log("forwarding-authz — unauth-takeover fix\n");

  const message = registrationMessage(
    owner.address as `0x${string}`,
    PRECOMMITMENT,
    NEXT_INDEX,
    NETWORK,
  );

  await ok("valid signature by the watchedAddress key verifies", async () => {
    const signature = await owner.signMessage({ message });
    const valid = await verifyMessage({ address: owner.address, message, signature });
    assert.equal(valid, true);
  });

  await ok("TAKEOVER BLOCKED: attacker's signature over owner's address fails", async () => {
    // The attacker tries to register a precommitment for the OWNER's watched
    // address, signing with their OWN key. verifyMessage against the owner's
    // address must reject it.
    const signature = await attacker.signMessage({ message });
    const valid = await verifyMessage({ address: owner.address, message, signature });
    assert.equal(valid, false, "attacker must NOT be able to bind a precommitment to the owner's address");
  });

  await ok("tampered precommitment invalidates the signature", async () => {
    const signature = await owner.signMessage({ message });
    const tampered = registrationMessage(
      owner.address as `0x${string}`,
      "99999999999999999999", // different precommitment
      NEXT_INDEX,
      NETWORK,
    );
    const valid = await verifyMessage({ address: owner.address, message: tampered, signature });
    assert.equal(valid, false, "a signature is bound to the exact precommitment");
  });

  await ok("tampered nextIndex invalidates the signature", async () => {
    const signature = await owner.signMessage({ message });
    const tampered = registrationMessage(
      owner.address as `0x${string}`,
      PRECOMMITMENT,
      NEXT_INDEX + 1,
      NETWORK,
    );
    const valid = await verifyMessage({ address: owner.address, message: tampered, signature });
    assert.equal(valid, false);
  });

  await ok("cross-network replay blocked (sepolia sig != mainnet message)", async () => {
    const signature = await owner.signMessage({ message }); // signed for sepolia
    const mainnetMsg = registrationMessage(
      owner.address as `0x${string}`,
      PRECOMMITMENT,
      NEXT_INDEX,
      "mainnet",
    );
    const valid = await verifyMessage({ address: owner.address, message: mainnetMsg, signature });
    assert.equal(valid, false, "a sepolia signature must not authorize a mainnet registration");
  });

  console.log(`\n${passed} passed\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
