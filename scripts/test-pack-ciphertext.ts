/**
 * Round-trip + invariant test for packCiphertext / unpackCiphertext (UTXO transfer
 * wire format). No chain, no deps — pure crypto/bytes.
 *   npx tsx scripts/test-pack-ciphertext.ts
 */
import * as assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { packCiphertext, unpackCiphertext, CIPHERTEXT_WIRE_VERSION } from "../packages/core/src/notes.js";

function rand(n: number): Uint8Array {
  const a = new Uint8Array(n);
  webcrypto.getRandomValues(a);
  return a;
}

let n = 0;
const ok = (m: string) => console.log(`${++n}. ${m}`);

// 1. Round-trips at realistic + edge sizes.
for (const size of [1, 58, 208, 300, 1024]) {
  const blob = rand(size);
  const packed = packCiphertext(blob);
  assert.match(packed, /^0x[0-9a-f]+$/, "packed must be 0x-hex");
  assert.equal(packed.length, 2 + (5 + size) * 2, `packed length for ${size}B`);
  const back = unpackCiphertext(packed);
  assert.ok(back, `unpack ${size}B must succeed`);
  assert.deepEqual(back, blob, `round-trip must be identity for ${size}B`);
}
ok("round-trips identity at 1/58/208/300/1024 bytes");

// 2. Header is version + big-endian length.
{
  const blob = rand(208);
  const packed = packCiphertext(blob);
  const hb = packed.slice(2); // strip 0x
  assert.equal(parseInt(hb.slice(0, 2), 16), CIPHERTEXT_WIRE_VERSION, "version byte");
  const len = parseInt(hb.slice(2, 10), 16);
  assert.equal(len, 208, "BE length prefix == blob length");
  ok("header = [version][BE length]");
}

// 3. Wrong version → null (scanner skips, doesn't throw).
{
  const blob = rand(64);
  const packed = packCiphertext(blob);
  const tampered = "0x02" + packed.slice(4); // flip version to 2
  assert.equal(unpackCiphertext(tampered), null, "wrong version → null");
  ok("wrong version rejected (null)");
}

// 4. Length-mismatch (truncated payload) → null.
{
  const blob = rand(100);
  const packed = packCiphertext(blob);
  const truncated = packed.slice(0, packed.length - 20); // drop 10 bytes of payload
  assert.equal(unpackCiphertext(truncated), null, "truncated → null");
  ok("truncated payload rejected (null)");
}

// 5. Garbage / too-short → null, never throws.
{
  assert.equal(unpackCiphertext("0x"), null);
  assert.equal(unpackCiphertext("0xdead"), null);
  assert.equal(unpackCiphertext("not-hex"), null);
  ok("garbage/short input rejected (null, no throw)");
}

// 6. Empty blob → pack throws (must be non-empty).
{
  assert.throws(() => packCiphertext(new Uint8Array(0)), /non-empty/);
  ok("empty envelope rejected at pack time");
}

console.log("\nscripts/test-pack-ciphertext.ts: all pack/unpack invariants hold");
