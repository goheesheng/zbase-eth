/**
 * Phase 1C vault route test — exercises /api/vault end-to-end with a real
 * (throwaway) EOA: signature auth, AES-GCM round-trip, version conflicts,
 * malformed-input rejections.
 *
 * Needs a running dev server:
 *   npm run dev -- -p 3110     (or set VAULT_TEST_BASE)
 *   npx tsx scripts/test-vault-route.ts
 *
 * No chain access, no funds — everything here is local crypto + HTTP.
 */

import * as assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { keccak256, hexToBytes } from "viem";
import { vaultAuthMessage, vaultKeyMessage } from "../src/lib/vault-messages";

const BASE = process.env.VAULT_TEST_BASE ?? "http://localhost:3110";

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}
function base64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

async function importAesKey(keyHex: `0x${string}`): Promise<CryptoKey> {
  return webcrypto.subtle.importKey(
    "raw",
    new Uint8Array(hexToBytes(keyHex)),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encrypt(keyHex: `0x${string}`, value: unknown): Promise<string> {
  const key = await importAesKey(keyHex);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await webcrypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(JSON.stringify(value)),
    ),
  );
  const blob = new Uint8Array(iv.length + ct.length);
  blob.set(iv, 0);
  blob.set(ct, iv.length);
  return bytesToBase64(blob);
}

async function decrypt(keyHex: `0x${string}`, b64: string): Promise<unknown> {
  const blob = base64ToBytes(b64);
  const key = await importAesKey(keyHex);
  const pt = await webcrypto.subtle.decrypt(
    { name: "AES-GCM", iv: blob.slice(0, 12) },
    key,
    blob.slice(12),
  );
  return JSON.parse(new TextDecoder().decode(pt));
}

async function main(): Promise<void> {
  const account = privateKeyToAccount(generatePrivateKey());
  const address = account.address.toLowerCase();

  // F2: auth message is time-boxed — sign over a fresh issuedAt and send the
  // matching X-Vault-Auth-Timestamp header on every request.
  const issuedAt = Date.now();
  const bearer = await account.signMessage({
    message: vaultAuthMessage(address, issuedAt),
  });
  const keySig = await account.signMessage({
    message: vaultKeyMessage(address),
  });
  const keyHex = keccak256(keySig);

  const auth = {
    Authorization: `Bearer ${bearer}`,
    "X-Vault-Auth-Timestamp": String(issuedAt),
  };
  const json = { "Content-Type": "application/json", ...auth };

  // 1. Fresh address → vault does not exist.
  {
    const res = await fetch(`${BASE}/api/vault?address=${address}`, {
      headers: auth,
    });
    assert.equal(res.status, 200, "GET fresh vault should be 200");
    const body = await res.json();
    assert.equal(body.exists, false, "fresh vault must not exist");
    console.log(`1. fresh GET ok (backend=${body.backend})`);
  }

  // 2. Unauthenticated GET → 401.
  {
    const res = await fetch(`${BASE}/api/vault?address=${address}`);
    assert.equal(res.status, 401, "GET without bearer must 401");
    console.log("2. missing bearer rejected");
  }

  // 3. Wrong wallet's bearer → 401.
  {
    const stranger = privateKeyToAccount(generatePrivateKey());
    const strangerBearer = await stranger.signMessage({
      message: vaultAuthMessage(address, issuedAt), // signs OUR address's message
    });
    const res = await fetch(`${BASE}/api/vault?address=${address}`, {
      headers: {
        Authorization: `Bearer ${strangerBearer}`,
        "X-Vault-Auth-Timestamp": String(issuedAt),
      },
    });
    assert.equal(res.status, 401, "stranger's signature must 401");
    console.log("3. stranger bearer rejected");
  }

  // 3b. F2: a STALE bearer (timestamp older than the TTL) → 401, even though the
  //     signature itself is valid. Proves a captured bearer expires.
  {
    const staleIssuedAt = Date.now() - 30 * 60 * 1000; // 30 min ago > 10 min TTL
    const staleBearer = await account.signMessage({
      message: vaultAuthMessage(address, staleIssuedAt),
    });
    const res = await fetch(`${BASE}/api/vault?address=${address}`, {
      headers: {
        Authorization: `Bearer ${staleBearer}`,
        "X-Vault-Auth-Timestamp": String(staleIssuedAt),
      },
    });
    assert.equal(res.status, 401, "stale (expired) bearer must 401");
    console.log("3b. stale bearer rejected (F2 replay defense)");
  }

  // 3c. F2: valid signature but MISSING timestamp header → 401.
  {
    const res = await fetch(`${BASE}/api/vault?address=${address}`, {
      headers: { Authorization: `Bearer ${bearer}` }, // no X-Vault-Auth-Timestamp
    });
    assert.equal(res.status, 401, "missing timestamp header must 401");
    console.log("3c. missing-timestamp bearer rejected");
  }

  // 4. PUT v1 → ok; GET round-trips the ciphertext; plaintext survives.
  const deposits = [
    {
      nullifier: "111",
      secret: "222",
      value: "990000",
      label: "42",
      commitment: "777",
      txHash: "0xabc",
      withdrawn: false,
    },
  ];
  {
    const res = await fetch(`${BASE}/api/vault`, {
      method: "PUT",
      headers: json,
      body: JSON.stringify({
        address,
        ciphertext: await encrypt(keyHex, deposits),
        version: 1,
      }),
    });
    assert.equal(res.status, 200, `PUT v1 should be 200, got ${res.status}`);
    const body = await res.json();
    assert.equal(body.version, 1, "PUT v1 must echo version 1");

    const get = await fetch(`${BASE}/api/vault?address=${address}`, {
      headers: auth,
    });
    const stored = await get.json();
    assert.equal(stored.exists, true, "vault must exist after PUT");
    assert.equal(stored.version, 1, "stored version must be 1");
    const roundTripped = (await decrypt(keyHex, stored.ciphertext)) as unknown[];
    assert.deepEqual(roundTripped, deposits, "decrypt(GET) must equal original");
    console.log("4. PUT v1 + GET round-trip ok");
  }

  // 5. Stale version (re-PUT v1) → 409 with storedVersion.
  {
    const res = await fetch(`${BASE}/api/vault`, {
      method: "PUT",
      headers: json,
      body: JSON.stringify({
        address,
        ciphertext: await encrypt(keyHex, deposits),
        version: 1,
      }),
    });
    assert.equal(res.status, 409, "stale version must 409");
    const body = await res.json();
    assert.equal(body.storedVersion, 1, "409 must report storedVersion");
    console.log("5. stale version rejected");
  }

  // 6. PUT v2 with updated state → ok; wrong-key decrypt fails closed.
  {
    const updated = [{ ...deposits[0], withdrawn: true }];
    const res = await fetch(`${BASE}/api/vault`, {
      method: "PUT",
      headers: json,
      body: JSON.stringify({
        address,
        ciphertext: await encrypt(keyHex, updated),
        version: 2,
      }),
    });
    assert.equal(res.status, 200, "PUT v2 should be 200");

    const get = await fetch(`${BASE}/api/vault?address=${address}`, {
      headers: auth,
    });
    const stored = await get.json();
    const wrongKey = keccak256(`0x${"11".repeat(32)}` as `0x${string}`);
    await assert.rejects(
      () => decrypt(wrongKey, stored.ciphertext),
      "wrong key must fail AEAD, not return garbage",
    );
    console.log("6. PUT v2 ok; wrong-key decrypt fails closed");
  }

  // 7. Malformed inputs.
  {
    const junk = await fetch(`${BASE}/api/vault`, {
      method: "PUT",
      headers: json,
      body: JSON.stringify({ address, ciphertext: "not base64!!!", version: 3 }),
    });
    assert.equal(junk.status, 400, "non-base64 ciphertext must 400");

    const badAddr = await fetch(`${BASE}/api/vault?address=zzz`, {
      headers: auth,
    });
    assert.equal(badAddr.status, 400, "malformed address must 400");

    const badVersion = await fetch(`${BASE}/api/vault`, {
      method: "PUT",
      headers: json,
      body: JSON.stringify({
        address,
        ciphertext: await encrypt(keyHex, deposits),
        version: 0,
      }),
    });
    assert.equal(badVersion.status, 400, "version 0 must 400");
    console.log("7. malformed inputs rejected");
  }

  console.log("\nscripts/test-vault-route.ts: all 7 vault invariants hold");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
