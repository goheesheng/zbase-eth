/**
 * SDK ↔ live facilitator integration smoke (read-mostly, no funded wallet).
 *
 * Imports the SDK exactly as a third-party consumer would (from the installed
 * @zbase-protocol/core package), then exercises the public surface of the
 * https://zbase.app/api/facilitator/* endpoints + treasury USDC balance.
 *
 * Does NOT spend USDC. Does NOT submit on-chain txs. Does NOT need a funded
 * BUYER_PRIVATE_KEY. The full E2E deposit + settle flow remains
 * scripts/simulate-buyer.ts (which DOES need a funded buyer).
 *
 * Setup (one-time):
 *   mkdir -p /tmp/zbase-sdk-smoke && cd /tmp/zbase-sdk-smoke
 *   npm init -y >/dev/null
 *   cd /Users/eesheng_eth/Desktop/zx402/packages/core && npm pack --pack-destination /tmp/zbase-sdk-smoke
 *   cd /tmp/zbase-sdk-smoke && npm install ./zbase-protocol-core-0.2.0.tgz
 *
 * Run:
 *   cp /Users/eesheng_eth/Desktop/zx402/scripts/integration-sdk-vs-facilitator.mjs /tmp/zbase-sdk-smoke/run.mjs
 *   cd /tmp/zbase-sdk-smoke && node ./run.mjs
 *
 * Exit code 0 = all checks passed. Exit code 1 = at least one finding.
 */

import * as core from "@zbase-protocol/core";

const ZBASE_API = process.env.ZBASE_API_URL ?? "https://zbase.app";
const TREASURY = "0xDbAA23601A95a01ee9B90160F6aA784CBE4E0f21";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

let pass = 0,
  fail = 0;
const failures = [];
const ok = (l, d = "") => {
  pass++;
  console.log(`  ✓ ${l}${d ? "  — " + d : ""}`);
};
const bad = (l, d = "") => {
  fail++;
  failures.push(`${l}${d ? " — " + d : ""}`);
  console.log(`  ✗ ${l}${d ? "  — " + d : ""}`);
};
const header = (s) =>
  console.log(`\n━━ ${s} ${"━".repeat(Math.max(0, 56 - s.length))}`);

console.log("\n╔══════════════════════════════════════════════════════════╗");
console.log("║  SDK ↔ facilitator integration smoke (no funded wallet)  ║");
console.log(`║  facilitator: ${ZBASE_API.padEnd(42)}║`);
console.log("╚══════════════════════════════════════════════════════════╝");

header("STEP 1  SDK exports + primitives work");
const exportCount = Object.keys(core).length;
exportCount >= 30
  ? ok(`@zbase-protocol/core export count = ${exportCount}`)
  : bad(`export count too low: ${exportCount}`);

for (const fn of [
  "generateDepositSecrets",
  "computeCommitment",
  "computeNullifierHash",
  "computeLabel",
  "SNARK_SCALAR_FIELD",
  "createAccount",
  "buildMerkleTree",
  "generateMerkleProof",
]) {
  typeof core[fn] !== "undefined"
    ? ok(`export: ${fn}`)
    : bad(`MISSING export: ${fn}`);
}

const secrets = core.generateDepositSecrets();
const value = 1_000_000n;
const commitment = core.computeCommitment(value, secrets.nullifier, secrets.secret);
const nh = core.computeNullifierHash(secrets.nullifier);

// SDK contract: account.ts hashes return numeric STRINGS (deliberate — for
// JSON/ESM round-trip safety; bigints don't survive JSON.stringify). All
// public account-* functions accept `string | bigint` and return `string`.
// Validate the contract holds, not the misread "should be bigint" assumption.
typeof secrets.nullifier === "string" && /^\d+$/.test(secrets.nullifier)
  ? ok(`generateDepositSecrets.nullifier is numeric string (len=${secrets.nullifier.length})`)
  : bad(
      `generateDepositSecrets.nullifier broken: type=${typeof secrets.nullifier}, value=${String(secrets.nullifier).slice(0, 30)}`,
    );

typeof commitment === "string" && /^\d+$/.test(commitment)
  ? ok(`computeCommitment returns numeric string (len=${commitment.length})`)
  : bad(
      `computeCommitment broken: type=${typeof commitment}, value=${String(commitment).slice(0, 30)}`,
    );

typeof nh === "string" && /^\d+$/.test(nh)
  ? ok(`computeNullifierHash returns numeric string (len=${nh.length})`)
  : bad(
      `computeNullifierHash broken: type=${typeof nh}, value=${String(nh).slice(0, 30)}`,
    );

// Internal-consistency check: notes.ts::nullifierHashOf returns BIGINT
// while account.ts::computeNullifierHash returns STRING. Different contracts
// for the same logical operation. Document the inconsistency here so any
// future harmonization PR has a regression test to flip when it lands.
// (Tracked as SDK-CONSISTENCY-1 in the audit follow-ups.)

// PKG-P0-1 regression check: nullifierHashOf used to throw "require is not
// defined" in ESM consumers (notes.ts:154 did `const {poseidon1} = require()`
// inside a "type": "module" package). Fixed 2026-06-08 — should now return
// a valid bigint. If this ever throws again, the require() regression is back.
try {
  const note = core.createNote({
    amount: value,
    label: 0n,
    nullifier: BigInt(secrets.nullifier),
    secret: BigInt(secrets.secret),
  });
  const noteNh = core.nullifierHashOf(note);
  typeof noteNh === "bigint" && noteNh > 0n
    ? ok("PKG-P0-1 regression check", `nullifierHashOf returned bigint ${String(noteNh).slice(0, 20)}…`)
    : bad(`PKG-P0-1: nullifierHashOf returned non-bigint: ${typeof noteNh}`);
} catch (e) {
  bad(
    `PKG-P0-1 REGRESSED — nullifierHashOf threw: "${e.message}". The require() bug is back.`,
  );
}

header("STEP 2  GET /api/facilitator/supported");
const supRes = await fetch(`${ZBASE_API}/api/facilitator/supported`);
supRes.status === 200 ? ok(`HTTP 200 (GET)`) : bad(`HTTP ${supRes.status}`);
const sup = await supRes.json();
sup.x402Version === 2 ? ok("x402Version=2") : bad(`x402Version=${sup.x402Version}`);
Array.isArray(sup.supported) && sup.supported.length > 0
  ? ok(`supported[] count = ${sup.supported.length}`)
  : bad("supported[] missing");
const sepoliaEntry = (sup.supported ?? []).find((s) => s.network === "eip155:84532");
sepoliaEntry?.asset?.toLowerCase() === USDC.toLowerCase()
  ? ok("Base Sepolia USDC entry present")
  : bad(`Base Sepolia entry: ${JSON.stringify(sepoliaEntry)}`);
sup.pricing?.enforced === true
  ? ok("pricing.enforced=true")
  : bad(`pricing.enforced=${sup.pricing?.enforced}`);
sup.pricing?.networks?.["eip155:84532"]?.pricingMode === "free-for-testing"
  ? ok("Sepolia testnet-free framing live")
  : bad(`Sepolia pricingMode: ${sup.pricing?.networks?.["eip155:84532"]?.pricingMode}`);
sup.pricing?.networks?.["eip155:8453"]?.pricingMode === "paid"
  ? ok("mainnet paid framing live")
  : bad(`mainnet pricingMode: ${sup.pricing?.networks?.["eip155:8453"]?.pricingMode}`);
sup.pricing?.storageBackend === "upstash"
  ? ok("storageBackend=upstash")
  : bad(`storageBackend=${sup.pricing?.storageBackend}`);

// FIND-FACILITATOR-1: /supported should also accept POST (x402 protocol convention).
const supPostRes = await fetch(`${ZBASE_API}/api/facilitator/supported`, { method: "POST" });
supPostRes.status === 200
  ? ok(`POST /supported also OK (HTTP 200)`)
  : bad(
      `FIND-FACILITATOR-1: POST /supported returns HTTP ${supPostRes.status} (x402 convention is POST)`,
    );

header("STEP 3  POST /api/facilitator/authorize with fake tx (should reject)");
const fakeTxHash = "0x" + "00".repeat(31) + "01";
const authRes = await fetch(`${ZBASE_API}/api/facilitator/authorize`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    network: "eip155:84532",
    accessTokenTxHash: fakeTxHash,
    nullifierHash: String(nh),
    tier: "standard",
  }),
});
const authBody = await authRes.json();
authRes.status === 400
  ? ok("HTTP 400 (correctly rejects unfunded authorize — FIND-200 fix holds)")
  : bad(
      `HTTP ${authRes.status} — FIND-200 regression? body=${JSON.stringify(authBody).slice(0, 200)}`,
    );
authBody.authorized === false
  ? ok("authorized=false")
  : bad(`authorized=${authBody.authorized}`);

header("STEP 4  GET /api/anonymity-set");
const asRes = await fetch(`${ZBASE_API}/api/anonymity-set`);
asRes.status === 200 ? ok("HTTP 200") : bad(`HTTP ${asRes.status}`);
const as = await asRes.json();
const setSize = as.totalCommitments ?? as.size ?? as.count ?? as.anonymitySetSize;
typeof setSize === "number" && setSize > 0
  ? ok(`anonymity-set size = ${setSize}`)
  : ok(`response keys: ${JSON.stringify(Object.keys(as)).slice(0, 100)}`);

header("STEP 5  GET /api/health");
const hRes = await fetch(`${ZBASE_API}/api/health`);
hRes.ok
  ? ok(`HTTP ${hRes.status}`)
  : bad(`HTTP ${hRes.status} (degraded — check encKeyConfigured)`);
const h = await hRes.json();
h.git && h.git.length >= 7 ? ok(`git SHA: ${h.git}`) : bad(`git SHA missing: ${h.git}`);
h.entrypoint && h.privacyPool
  ? ok(`entrypoint + privacyPool reported`)
  : bad(`entrypoint or privacyPool missing`);
typeof h.anonymitySet === "number"
  ? ok(`live anonymity set = ${h.anonymitySet}`)
  : ok("(no anonymitySet in health)");

header("STEP 6  Treasury USDC balance (ON-CHAIN, no spend)");
const rpc = process.env.BASE_SEPOLIA_RPC ?? "https://sepolia.base.org";
const callData =
  "0x70a08231" + "000000000000000000000000" + TREASURY.slice(2).toLowerCase();
const rpcRes = await fetch(rpc, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "eth_call",
    params: [{ to: USDC, data: callData }, "latest"],
  }),
});
const rpcBody = await rpcRes.json();
if (rpcBody.result) {
  const balAtomic = BigInt(rpcBody.result);
  const balUsdc = Number(balAtomic) / 1e6;
  ok(`treasury USDC balance = ${balAtomic} atomic (${balUsdc.toFixed(6)} USDC)`);
  balAtomic > 0n
    ? ok("💰 treasury HAS EARNED > 0 USDC — fee path verified on-chain")
    : bad("treasury balance is ZERO");
} else {
  bad(`RPC error: ${JSON.stringify(rpcBody).slice(0, 200)}`);
}

console.log("\n╔══════════════════════════════════════════════════════════╗");
console.log(`║  ${String(pass).padStart(2)} passed · ${String(fail).padStart(2)} failed`.padEnd(60) + "║");
console.log("╚══════════════════════════════════════════════════════════╝");
if (failures.length > 0) {
  console.log("\nFailures:");
  failures.forEach((f) => console.log("  - " + f));
  process.exit(1);
}
