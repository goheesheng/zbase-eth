/**
 * scripts/test-stealth.ts — Shipment B.1 acceptance test.
 *
 * What this proves:
 *   - A provider generates one ERC-5564 meta-address (one-time setup).
 *   - The facilitator derives 100 distinct stealth addresses for 100 calls
 *     to that provider, using only the public meta-address.
 *   - The provider scans 100 ephemeral pubkeys and recovers all 100 stealth
 *     addresses + their private keys, with view-tag optimisation matching
 *     the full scan.
 *
 * Hard asserts:
 *   - No two of the 100 stealth addresses are equal.
 *   - None of them equal the meta-address's spending public key (would mean
 *     the shared-secret hash collapsed to zero — a bug).
 *   - All 100 recover correctly (stealthPrivateKey · G == stealthPubKey).
 *
 * Run: `npx tsx scripts/test-stealth.ts`
 */

import { strict as assert } from "node:assert";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";

import {
  generateMetaAddress,
  parseMetaAddress,
  deriveStealthAddress,
  scanForPayments,
  computeStealthPrivateKey,
  isStealthMetaAddress,
  STEALTH_SCHEME_ID,
} from "../packages/core/src/stealth.js";

const N = 100;

function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function hexToBytes(h: string): Uint8Array {
  const s = h.startsWith("0x") ? h.slice(2) : h;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function pubKeyToAddress(pubKeyCompressed: Uint8Array): string {
  // Decompress + take last 20 bytes of keccak256(uncompressed[1:])
  const PP = (secp256k1 as unknown as { ProjectivePoint: { fromHex(b: Uint8Array): { toRawBytes(c: boolean): Uint8Array } } }).ProjectivePoint;
  const uncompressed = PP.fromHex(pubKeyCompressed).toRawBytes(false);
  return "0x" + hex(keccak_256(uncompressed.slice(1)).slice(12));
}

console.log(`Shipment B.1 — ERC-5564 stealth recipients (scheme id ${STEALTH_SCHEME_ID})`);
console.log("─".repeat(72));

// ─── Step 1: provider generates one meta-address ────────────────────────────
console.log("Step 1: provider generates meta-address (one-time)");
const provider = generateMetaAddress();
assert.ok(isStealthMetaAddress(provider.metaAddress), "metaAddress must look like an st: URI");
assert.match(
  provider.metaAddress,
  /^st:[a-z0-9]+:0x[0-9a-f]{132}$/,
  "metaAddress must be st:<chain>:0x<132 hex chars>",
);
console.log(`  metaAddress = ${provider.metaAddress.slice(0, 24)}...${provider.metaAddress.slice(-8)}`);
console.log(`  spending pubkey = ${provider.spendingPublicKey.slice(0, 12)}...`);
console.log(`  viewing  pubkey = ${provider.viewingPublicKey.slice(0, 12)}...`);

// Parse round-trips.
const parsed = parseMetaAddress(provider.metaAddress);
assert.equal(parsed.spendingPublicKey.length, 33, "spending pubkey must be 33 bytes compressed");
assert.equal(parsed.viewingPublicKey.length, 33, "viewing pubkey must be 33 bytes compressed");
assert.equal("0x" + hex(parsed.spendingPublicKey), provider.spendingPublicKey, "spending pubkey round-trip");
assert.equal("0x" + hex(parsed.viewingPublicKey), provider.viewingPublicKey, "viewing pubkey round-trip");

// ─── Step 2: facilitator generates 100 stealth addresses ─────────────────────
console.log(`\nStep 2: facilitator derives ${N} stealth addresses for ${N} payments`);
const derivations = [];
for (let i = 0; i < N; i++) {
  derivations.push(deriveStealthAddress(provider.metaAddress));
}
console.log(`  first stealth addr  = ${derivations[0].stealthAddress}`);
console.log(`  last  stealth addr  = ${derivations[N - 1].stealthAddress}`);

// Assert: all 100 stealth addresses are distinct.
const seenAddrs = new Set(derivations.map((d) => d.stealthAddress.toLowerCase()));
assert.equal(seenAddrs.size, N, `expected ${N} unique stealth addresses, got ${seenAddrs.size}`);

// Assert: all 100 ephemeral pubkeys are distinct (would indicate weak RNG otherwise).
const seenEph = new Set(derivations.map((d) => d.ephemeralPublicKey.toLowerCase()));
assert.equal(seenEph.size, N, `expected ${N} unique ephemeral pubkeys, got ${seenEph.size}`);

// Assert: no stealth address collides with the provider's spending pubkey
// (which would mean the hashed shared secret was zero, a critical bug).
const spendingAddress = pubKeyToAddress(parsed.spendingPublicKey);
for (const d of derivations) {
  assert.notEqual(
    d.stealthAddress.toLowerCase(),
    spendingAddress.toLowerCase(),
    "stealth addr must not equal the spending pubkey's address",
  );
}
console.log(`  all ${N} addresses distinct, none collide with provider's spending key`);

// ─── Step 3: provider scans all 100 ephemeral pubkeys ────────────────────────
console.log(`\nStep 3: provider scans ${N} ephemeral pubkeys with view-tag fast path`);
const ephemeralPubkeys = derivations.map((d) => d.ephemeralPublicKey);
const viewTags = derivations.map((d) => d.viewTag);

const t0 = performance.now();
const matchesWithTag = scanForPayments(
  provider.viewingPrivateKey,
  ephemeralPubkeys,
  provider.spendingPublicKey,
  viewTags,
);
const tWithTag = performance.now() - t0;

const t1 = performance.now();
const matchesNoTag = scanForPayments(
  provider.viewingPrivateKey,
  ephemeralPubkeys,
  provider.spendingPublicKey,
);
const tNoTag = performance.now() - t1;

assert.equal(matchesWithTag.length, N, `view-tag scan should match all ${N} (these are all ours)`);
assert.equal(matchesNoTag.length, N, `unfiltered scan should also match all ${N}`);

// Both scans should agree on stealth addresses.
for (let i = 0; i < N; i++) {
  assert.equal(
    matchesWithTag[i].stealthAddress.toLowerCase(),
    derivations[i].stealthAddress.toLowerCase(),
    `match[${i}] address mismatch (view-tag path)`,
  );
  assert.equal(
    matchesNoTag[i].stealthAddress.toLowerCase(),
    derivations[i].stealthAddress.toLowerCase(),
    `match[${i}] address mismatch (full path)`,
  );
}
console.log(`  view-tag scan: ${tWithTag.toFixed(1)}ms · full scan: ${tNoTag.toFixed(1)}ms`);
console.log(`  both scans recovered all ${N} stealth addresses`);

// Negative case: a foreign ephemeral pubkey with a deliberately wrong view
// tag should be filtered out by the fast path.
{
  const foreign = secp256k1.getPublicKey(secp256k1.utils.randomPrivateKey(), true);
  const wrongTag = "0xff"; // overwhelmingly unlikely to match
  const stray = scanForPayments(
    provider.viewingPrivateKey,
    [...ephemeralPubkeys, foreign],
    provider.spendingPublicKey,
    [...viewTags, wrongTag],
  );
  // The foreign one is filtered out by view-tag; we still see our N.
  assert.equal(stray.length, N, "view-tag must drop foreign announcement with mismatched tag");
}

// ─── Step 4: provider recovers all 100 stealth private keys ──────────────────
console.log(`\nStep 4: provider recovers stealth private keys & verifies on-curve`);
for (let i = 0; i < N; i++) {
  const sk = computeStealthPrivateKey(
    provider.spendingPrivateKey,
    provider.viewingPrivateKey,
    derivations[i].ephemeralPublicKey,
  );
  assert.equal(sk.length, 32, `stealth privkey #${i} must be 32 bytes`);

  // Derive the corresponding public key and address; must match what the
  // facilitator computed without ever touching the private keys.
  const pk = secp256k1.getPublicKey(sk, true);
  const addr = pubKeyToAddress(pk);
  assert.equal(
    addr.toLowerCase(),
    derivations[i].stealthAddress.toLowerCase(),
    `recovered stealth privkey #${i} does not produce the facilitator-derived address`,
  );
}
console.log(`  all ${N} private keys recover the correct on-chain addresses`);

// ─── Step 5: cross-check determinism of derivation ───────────────────────────
console.log(`\nStep 5: determinism — same nonce → same stealth address`);
{
  const nonce = hexToBytes("11".repeat(32));
  const a = deriveStealthAddress(provider.metaAddress, nonce);
  const b = deriveStealthAddress(provider.metaAddress, nonce);
  assert.equal(a.stealthAddress, b.stealthAddress, "deterministic nonce must produce deterministic addr");
  assert.equal(a.ephemeralPublicKey, b.ephemeralPublicKey, "deterministic nonce → deterministic R");
  assert.equal(a.viewTag, b.viewTag, "deterministic nonce → deterministic view tag");
}

// ─── Step 6: seeded meta-address determinism ─────────────────────────────────
console.log(`\nStep 6: seeded meta-address — same 64-byte seed → same meta-address`);
{
  const seed = new Uint8Array(64);
  for (let i = 0; i < 64; i++) seed[i] = i + 1;
  const m1 = generateMetaAddress(seed);
  const m2 = generateMetaAddress(seed);
  assert.equal(m1.metaAddress, m2.metaAddress, "same seed must produce same meta-address");
  assert.notEqual(m1.metaAddress, provider.metaAddress, "different seed must produce different meta-address");
}

console.log("\n" + "─".repeat(72));
console.log(`PASS — Shipment B.1 stealth SDK invariants hold for ${N} payments`);
