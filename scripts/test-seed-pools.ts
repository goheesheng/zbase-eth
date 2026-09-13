/**
 * scripts/test-seed-pools.ts — Offline tests for Shipment B.3.
 *
 * No live RPC, no real signing — these tests exercise the pure-function
 * surface of the seed/reclaim scripts:
 *
 *   1. dryRun planning counts 100 deposits across 4 denoms (25 + 25 + 25 + 25)
 *      and refuses to load an invalid config.
 *   2. encryptNotes() output is unreadable without the key, and reading the
 *      ciphertext as JSON does NOT reveal any amounts or commitments.
 *   3. decryptNotes() round-trips, and rejects tampered ciphertext.
 *   4. Reclaim script refuses to run before lockUntil.
 *
 * Run with:
 *   tsx scripts/test-seed-pools.ts
 *
 * Exits non-zero on the first failure.
 */

import "./load-env";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { argv, exit, env } from "node:process";

import {
  loadConfig,
  encryptNotes,
  writeEncryptedNotes,
  loadPriorNotesForResume,
  parseLockUntil,
  randomFieldElement,
  type SeedNote,
  type EncryptedNotesFile,
} from "./seed-pools.ts";
import { decryptNotes } from "./reclaim-seed-pools.ts";

let passed = 0;
let failed = 0;

function ok(label: string) {
  console.log(`  PASS  ${label}`);
  passed++;
}

function fail(label: string, err: unknown) {
  console.error(`  FAIL  ${label}`);
  console.error(`        ${(err as Error).message}`);
  failed++;
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function eq<T>(a: T, b: T, msg: string) {
  if (a !== b) throw new Error(`${msg}: expected ${String(b)}, got ${String(a)}`);
}

// Fixed 32-byte key for deterministic tests (NEVER use this in production).
const TEST_KEY = "0".repeat(64);

// Build a synthetic, on-chain-shaped seed note. We don't sign anything.
function makeNote(i: number, amount = "1000000", denom = "1"): SeedNote {
  return {
    poolAddress: "0x4ebcfeaf661a25f103b3d1f16be5a7668ab0935a",
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    denomLabel: denom,
    amountAtomic: amount,
    valueAtomic: (BigInt(amount) - BigInt(amount) / 100n).toString(), // 1% fee
    nullifier: randomFieldElement().toString(),
    secret: randomFieldElement().toString(),
    label: (12345n + BigInt(i)).toString(),
    commitment: (98765n + BigInt(i)).toString(),
    precommitment: (55555n + BigInt(i)).toString(),
    txHash: `0x${i.toString(16).padStart(64, "0")}`,
    blockNumber: (40700000n + BigInt(i)).toString(),
    timestamp: 1735689600 + i,
    depositor: "0xcDB447c3a352AD8ADF3D8d97Da9a3CF91880b843",
    reclaimed: false,
  };
}

// ── Test 1: loadConfig + plan counts ──────────────────────────────────────

function testLoadConfig() {
  const tmp = mkdtempSync(join(tmpdir(), "zb-seed-"));
  const path = join(tmp, "config.json");
  const cfg = {
    treasury: "0xcDB447c3a352AD8ADF3D8d97Da9a3CF91880b843",
    pools: [
      {
        address: "0x4ebcfeaf661a25f103b3d1f16be5a7668ab0935a",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        assetDecimals: 6,
        label: "USDC",
        denomCount: { "1": 25, "10": 25, "100": 25, "1000": 25 },
      },
    ],
    lockUntil: "2026-12-01T00:00:00Z",
    encryptedNotesPath: join(tmp, "notes.encrypted.json"),
    entrypoint: "0x598ffaac79ae29b1aae571fd91899d4492183688",
    chainId: 84532,
  };
  writeFileSync(path, JSON.stringify(cfg), "utf8");

  const { config } = loadConfig(path);
  let total = 0;
  for (const p of config.pools) {
    for (const c of Object.values(p.denomCount)) total += c;
  }
  eq(total, 100, "expected 100 planned deposits");
  rmSync(tmp, { recursive: true, force: true });
}

// ── Test 2: invalid config rejected ───────────────────────────────────────

function testInvalidConfig() {
  const tmp = mkdtempSync(join(tmpdir(), "zb-seed-"));
  const path = join(tmp, "config.json");

  const cases = [
    { ...baseGoodConfig(tmp), treasury: "bad" },
    { ...baseGoodConfig(tmp), pools: [] },
    { ...baseGoodConfig(tmp), lockUntil: "not-a-date" },
  ];
  for (const c of cases) {
    writeFileSync(path, JSON.stringify(c), "utf8");
    let threw = false;
    try {
      loadConfig(path);
    } catch {
      threw = true;
    }
    assert(threw, `expected config to throw: ${JSON.stringify(c).slice(0, 60)}...`);
  }
  rmSync(tmp, { recursive: true, force: true });
}

function baseGoodConfig(tmp: string) {
  return {
    treasury: "0xcDB447c3a352AD8ADF3D8d97Da9a3CF91880b843",
    pools: [
      {
        address: "0x4ebcfeaf661a25f103b3d1f16be5a7668ab0935a",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        assetDecimals: 6,
        label: "USDC",
        denomCount: { "1": 1 },
      },
    ],
    lockUntil: "2026-12-01T00:00:00Z",
    encryptedNotesPath: join(tmp, "notes.encrypted.json"),
    entrypoint: "0x598ffaac79ae29b1aae571fd91899d4492183688",
    chainId: 84532,
  };
}

// ── Test 3: encryption hides amounts ──────────────────────────────────────

function testEncryptionHidesAmounts() {
  const notes = [makeNote(0, "1000000", "1"), makeNote(1, "10000000", "10")];
  const plaintext = JSON.stringify(notes);
  const { iv, authTag, ciphertext } = encryptNotes(plaintext, TEST_KEY);

  // Amount strings should NOT appear anywhere in the ciphertext or metadata.
  for (const needle of ["1000000", "10000000", notes[0].nullifier, notes[0].secret]) {
    if (ciphertext.includes(needle)) {
      throw new Error(`ciphertext leaks "${needle.slice(0, 12)}..."`);
    }
  }
  assert(iv.length > 0 && authTag.length > 0, "iv/authTag should be populated");
}

// ── Test 4: round-trip decrypt ────────────────────────────────────────────

function testRoundTrip() {
  const tmp = mkdtempSync(join(tmpdir(), "zb-seed-"));
  const cfg = baseGoodConfig(tmp);
  writeFileSync(join(tmp, "config.json"), JSON.stringify(cfg), "utf8");
  const { config } = loadConfig(join(tmp, "config.json"));
  const notes = [makeNote(0), makeNote(1), makeNote(2)];
  const file = writeEncryptedNotes(config, notes, TEST_KEY);
  eq(file.totalNotes, 3, "totalNotes should equal note count");
  eq(file.pools[0].commitments.length, 3, "pools[0].commitments should list all");

  const raw = JSON.parse(readFileSync(cfg.encryptedNotesPath, "utf8")) as EncryptedNotesFile;
  const recovered = decryptNotes(raw, TEST_KEY);
  eq(recovered.length, 3, "decrypted count");
  eq(recovered[0].nullifier, notes[0].nullifier, "nullifier round-trip");
  eq(recovered[2].commitment, notes[2].commitment, "commitment round-trip");

  rmSync(tmp, { recursive: true, force: true });
}

// ── Test 5: tampered ciphertext is rejected ───────────────────────────────

function testTamperRejected() {
  const tmp = mkdtempSync(join(tmpdir(), "zb-seed-"));
  const cfg = baseGoodConfig(tmp);
  writeFileSync(join(tmp, "config.json"), JSON.stringify(cfg), "utf8");
  const { config } = loadConfig(join(tmp, "config.json"));
  writeEncryptedNotes(config, [makeNote(0)], TEST_KEY);
  const raw = JSON.parse(readFileSync(cfg.encryptedNotesPath, "utf8")) as EncryptedNotesFile;

  // Flip a byte in the base64 ciphertext.
  const buf = Buffer.from(raw.ciphertext, "base64");
  buf[0] = buf[0] ^ 0xff;
  raw.ciphertext = buf.toString("base64");

  let threw = false;
  try {
    decryptNotes(raw, TEST_KEY);
  } catch {
    threw = true;
  }
  assert(threw, "expected decrypt to throw on tampered ciphertext");

  rmSync(tmp, { recursive: true, force: true });
}

// ── Test 6: reclaim refuses pre-lock ──────────────────────────────────────

function testReclaimRefusesPreLock() {
  const tmp = mkdtempSync(join(tmpdir(), "zb-seed-"));
  const future = new Date(Date.now() + 365 * 86_400_000).toISOString();
  const cfg = { ...baseGoodConfig(tmp), lockUntil: future };
  const cfgPath = join(tmp, "config.json");
  writeFileSync(cfgPath, JSON.stringify(cfg), "utf8");

  // Plant an encrypted file so the reclaim script reaches the lock check.
  const { config } = loadConfig(cfgPath);
  writeEncryptedNotes(config, [makeNote(0)], TEST_KEY);

  const scriptPath = join(import.meta.dirname ?? __dirname, "reclaim-seed-pools.ts");
  const result = spawnSync(
    "npx",
    ["--yes", "tsx", scriptPath, "--config", cfgPath, "--dry-run"],
    {
      env: { ...env, ZBASE_SEED_ENCRYPTION_KEY: TEST_KEY, PATH: env.PATH ?? "" },
      encoding: "utf8",
    },
  );
  // Expect exit 2 (lock guard).
  eq(result.status, 2, `expected exit 2, got ${result.status}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`);
  const combined = (result.stdout ?? "") + (result.stderr ?? "");
  assert(
    combined.includes("REFUSING TO RECLAIM"),
    `expected REFUSING TO RECLAIM in output, got:\n${combined.slice(0, 400)}`,
  );

  rmSync(tmp, { recursive: true, force: true });
}

// ── Test 7: parseLockUntil ────────────────────────────────────────────────

function testParseLockUntil() {
  const ms = parseLockUntil("2026-12-01T00:00:00Z");
  assert(ms > Date.now(), "lockUntil should be in the future");
}

// ── Test 8: loadPriorNotesForResume — empty when no file ─────────────────

function testResumeReturnsEmptyWhenNoFile() {
  const tmp = mkdtempSync(join(tmpdir(), "zb-seed-"));
  const cfg = baseGoodConfig(tmp);
  const cfgPath = join(tmp, "config.json");
  writeFileSync(cfgPath, JSON.stringify(cfg), "utf8");
  const { config } = loadConfig(cfgPath);

  const prior = loadPriorNotesForResume(config, TEST_KEY);
  eq(prior.length, 0, "should return [] when encryptedNotesPath does not exist");

  rmSync(tmp, { recursive: true, force: true });
}

// ── Test 9: loadPriorNotesForResume — round-trip after partial run ───────

function testResumeLoadsPriorRun() {
  const tmp = mkdtempSync(join(tmpdir(), "zb-seed-"));
  const cfg = baseGoodConfig(tmp);
  const cfgPath = join(tmp, "config.json");
  writeFileSync(cfgPath, JSON.stringify(cfg), "utf8");
  const { config } = loadConfig(cfgPath);

  const partial = [makeNote(0, "1000000", "1"), makeNote(1, "10000000", "10")];
  writeEncryptedNotes(config, partial, TEST_KEY);

  const recovered = loadPriorNotesForResume(config, TEST_KEY);
  eq(recovered.length, 2, "resume should load the 2 prior notes");
  eq(recovered[0].nullifier, partial[0].nullifier, "nullifier preserved across resume");
  eq(recovered[1].denomLabel, "10", "denomLabel preserved across resume");

  rmSync(tmp, { recursive: true, force: true });
}

// ── Test 10: loadPriorNotesForResume — wrong key refuses to clobber ──────

function testResumeRefusesWrongKey() {
  const tmp = mkdtempSync(join(tmpdir(), "zb-seed-"));
  const cfg = baseGoodConfig(tmp);
  const cfgPath = join(tmp, "config.json");
  writeFileSync(cfgPath, JSON.stringify(cfg), "utf8");
  const { config } = loadConfig(cfgPath);

  writeEncryptedNotes(config, [makeNote(0)], TEST_KEY);

  const WRONG_KEY = "f".repeat(64);
  let threw = false;
  let message = "";
  try {
    loadPriorNotesForResume(config, WRONG_KEY);
  } catch (err) {
    threw = true;
    message = (err as Error).message;
  }
  assert(threw, "expected wrong-key resume to throw");
  assert(
    message.includes("Refusing to resume"),
    `expected 'Refusing to resume' in error, got: ${message.slice(0, 200)}`,
  );

  rmSync(tmp, { recursive: true, force: true });
}

// ── Runner ────────────────────────────────────────────────────────────────

async function run() {
  const tests: Array<[string, () => void | Promise<void>]> = [
    ["loadConfig: 100 planned deposits", testLoadConfig],
    ["loadConfig: invalid configs rejected", testInvalidConfig],
    ["encryptNotes: ciphertext hides amounts + secrets", testEncryptionHidesAmounts],
    ["round-trip: encrypt → decrypt preserves notes", testRoundTrip],
    ["tamper: flipped ciphertext is rejected", testTamperRejected],
    ["reclaim: refuses to run before lockUntil", testReclaimRefusesPreLock],
    ["util: parseLockUntil basic", testParseLockUntil],
    ["resume: empty when no file", testResumeReturnsEmptyWhenNoFile],
    ["resume: loads prior partial run", testResumeLoadsPriorRun],
    ["resume: wrong key refuses to clobber", testResumeRefusesWrongKey],
  ];

  console.log("\nzBase Seed Pool — offline test suite\n");
  for (const [label, fn] of tests) {
    try {
      await fn();
      ok(label);
    } catch (err) {
      fail(label, err);
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) exit(1);
}

const isDirectRun = (() => {
  try {
    const entry = argv[1] ?? "";
    return entry.endsWith("test-seed-pools.ts") || entry.endsWith("test-seed-pools.js");
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  run();
}
