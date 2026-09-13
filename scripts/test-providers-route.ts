/**
 * scripts/test-providers-route.ts — light smoke test of the providers/register
 * Next.js route handler called directly (no http server).
 *
 * Confirms:
 *   - valid registration round-trips and lands in data/providers.json
 *   - bad meta-address is rejected
 *   - duplicate registration is rejected
 *   - findProviderByPayTo resolves both meta-address and fallback
 */

import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import path from "node:path";
import { generateMetaAddress } from "../packages/core/src/stealth.js";

// Use a temp registry so we don't clobber any real data.
const tmpDir = await fs.mkdtemp(path.join(process.cwd(), "data-stealth-test-"));
process.chdir(tmpDir);
await fs.mkdir(path.join(tmpDir, "data"), { recursive: true });

const { POST, GET } = await import("../src/app/api/providers/register/route.js");
const { findProviderByPayTo } = await import("../src/app/api/providers/register/route.js");

async function post(body: unknown) {
  const req = new Request("http://localhost/api/providers/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = await POST(req);
  return { status: res.status, body: await res.json() };
}

async function get(qs = "") {
  const req = new Request("http://localhost/api/providers/register" + qs);
  const res = await GET(req);
  return { status: res.status, body: await res.json() };
}

// 1. Valid registration
const me = generateMetaAddress();
const reg = await post({
  providerName: "Test Provider",
  metaAddress: me.metaAddress,
  contactEmail: "ops@example.com",
  fallbackPayTo: "0xDbAA23601A95a01ee9B90160F6aA784CBE4E0f21",
});
assert.equal(reg.status, 200, `expected 200, got ${reg.status}: ${JSON.stringify(reg.body)}`);
assert.equal(reg.body.registered, true);
assert.equal(reg.body.provider.providerName, "Test Provider");
assert.equal(reg.body.provider.metaAddress, me.metaAddress);
assert.equal(reg.body.provider.schemeId, 1);
console.log(`  ✓ registered ${reg.body.provider.id}`);

// 2. File was persisted
const file = JSON.parse(await fs.readFile(path.join(tmpDir, "data", "providers.json"), "utf8"));
assert.equal(file.providers.length, 1);
assert.equal(file.providers[0].metaAddress, me.metaAddress);
console.log("  ✓ providers.json persisted");

// 3. Bad meta-address rejected
{
  const bad = await post({
    providerName: "Bad",
    metaAddress: "st:base:0xdeadbeef",
    contactEmail: "ops@example.com",
  });
  assert.equal(bad.status, 400, "short meta-address must be rejected");
  console.log("  ✓ short meta-address rejected");
}

// 4. Off-curve meta-address rejected
{
  const bad = await post({
    providerName: "Bad",
    metaAddress: "st:base:0x" + "00".repeat(66),
    contactEmail: "ops@example.com",
  });
  assert.equal(bad.status, 400, "off-curve meta-address must be rejected");
  console.log("  ✓ off-curve meta-address rejected");
}

// 5. Bad email rejected
{
  const bad = await post({
    providerName: "Bad",
    metaAddress: me.metaAddress, // duplicate anyway
    contactEmail: "not-an-email",
  });
  assert.equal(bad.status, 400, "bad email must be rejected");
  console.log("  ✓ bad email rejected");
}

// 6. Duplicate meta-address rejected (409)
{
  const dup = await post({
    providerName: "Other",
    metaAddress: me.metaAddress,
    contactEmail: "ops2@example.com",
  });
  assert.equal(dup.status, 409, "duplicate meta-address must be rejected");
  console.log("  ✓ duplicate meta-address rejected (409)");
}

// 7. GET listing
{
  const list = await get();
  assert.equal(list.status, 200);
  assert.equal(list.body.providers.length, 1);
  assert.equal(list.body.providers[0].metaAddress, me.metaAddress);
  assert.equal(list.body.providers[0].contactEmail, undefined, "email must be hidden in listing");
  console.log("  ✓ GET listing returns provider; email hidden");
}

// 8. findProviderByPayTo resolves both forms
{
  const byMeta = await findProviderByPayTo(me.metaAddress);
  assert.ok(byMeta, "meta-address must resolve");
  assert.equal(byMeta!.providerName, "Test Provider");

  const byFallback = await findProviderByPayTo("0xDbAA23601A95a01ee9B90160F6aA784CBE4E0f21");
  assert.ok(byFallback, "fallback 0x address must resolve");
  assert.equal(byFallback!.providerName, "Test Provider");

  // case-insensitive
  const byFallbackLower = await findProviderByPayTo("0xdbaa23601a95a01ee9b90160f6aa784cbe4e0f21");
  assert.ok(byFallbackLower, "fallback resolution must be case-insensitive");

  const missing = await findProviderByPayTo("0x0000000000000000000000000000000000000001");
  assert.equal(missing, null, "unregistered address must return null");
  console.log("  ✓ findProviderByPayTo resolves meta-address, fallback (case-insensitive), and null on miss");
}

// Cleanup
await fs.rm(tmpDir, { recursive: true, force: true });
console.log("\nPASS — providers/register route smoke test");
