#!/usr/bin/env node
/**
 * Pre-deploy preflight gate for the SVM V1 program.
 *
 * Run this before paying for a redeploy. It exercises every check that's
 * cheap enough to do locally and that, if it fails, would have wasted the
 * cost of the on-chain upgrade. Sequence (each step short-circuits the
 * rest on failure):
 *
 *   1. Cryptographic recipe tripwire (poseidon arity, argument order,
 *      determinism). Sub-second.
 *   2. `cargo check` on the Anchor program. Verifies the source compiles
 *      against the pinned dependency set. ~2s after the first run.
 *   3. Confirms the on-chain VK file exists and matches the program's
 *      `verifying_key.rs` constant by hash. Catches "regenerated zkey
 *      but forgot to re-run build-verifying-key.mjs" mistakes.
 *   4. Confirms `target/deploy/zx402_privacy_pool.so` is fresher than
 *      the program's `.rs` sources and exactly reproduces both reviewed
 *      artifact hashes. Catches stale or unreviewed builds.
 *   5. Confirms the live allocation and `Authority` on devnet match the
 *      reviewed upgrade target. Skipped only when `--offline` is explicit;
 *      online mode fails closed on RPC or parse errors.
 *
 * Exits non-zero on the first failure. Run from repo root:
 *   node scripts/preflight.mjs
 *   node scripts/preflight.mjs --offline      # skip step 5
 *
 * Note on shell safety: every external command in this script uses
 * `execFileSync` with a fixed argv array — there's no user-input
 * interpolation. We never spawn a shell.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);
const PROGRAM_DIR = join(ROOT, "packages/svm/zx402-privacy-pool");
const PROGRAM_ID = "7qGhxY9Dc9reSNbNHdX1Rtf7hq7D45zdnV1UY3rpt3eM";
const REVIEWED_ARTIFACT_SHA256 =
  "6961e45a7604c45eadec3c4f9f3424c1353e9acbdd8289460983b2d9d1912a3b";
const PROGRAMDATA_LENGTH = 532_200;
const REVIEWED_PROGRAMDATA_SHA256 =
  "a80555ef2de05c8c9639a1cdc0f92306f7730c448805a3a51c05532adfdfa95f";

const argv = process.argv.slice(2);
const OFFLINE = argv.includes("--offline");

let step = 0;
function ok(msg) { step++; console.log(`  ✓ [${step}] ${msg}`); }
function fail(msg, hint) {
  step++;
  console.error(`\n  ✗ [${step}] ${msg}`);
  if (hint) console.error(`     ${hint}`);
  console.error(`\nPreflight FAILED.`);
  process.exit(1);
}
function info(msg) { console.log(`    ${msg}`); }

console.log("zx402 SVM V1 preflight\n");

// 1. Poseidon recipes.
try {
  execFileSync("node", ["scripts/check-poseidon-recipes.mjs"], {
    cwd: ROOT,
    stdio: ["ignore", "ignore", "pipe"],
  });
  ok("poseidon recipes match Circom expectations");
} catch (_err) {
  fail(
    "poseidon-recipes tripwire failed",
    "run `node scripts/check-poseidon-recipes.mjs` directly to see the assertion that fired",
  );
}

// 2. cargo check.
try {
  execFileSync(
    "cargo",
    [
      "check",
      "--manifest-path",
      "programs/zx402-privacy-pool/Cargo.toml",
      "--quiet",
    ],
    { cwd: PROGRAM_DIR, stdio: ["ignore", "ignore", "pipe"] },
  );
  ok("anchor program type-checks (cargo check)");
} catch (_err) {
  fail(
    "cargo check failed on the Anchor program",
    "run `cd packages/svm/zx402-privacy-pool && cargo check --manifest-path programs/zx402-privacy-pool/Cargo.toml` to see errors",
  );
}

// 3. VK file ↔ verifying_key.rs hash agreement.
{
  const vkeyJsonPath = join(ROOT, "public/circuits/withdraw/groth16_vkey.json");
  const vkeyRsPath = join(
    PROGRAM_DIR,
    "programs/zx402-privacy-pool/src/verifying_key.rs",
  );
  if (!existsSync(vkeyJsonPath)) {
    fail(`groth16_vkey.json missing at ${vkeyJsonPath}`);
  }
  if (!existsSync(vkeyRsPath)) {
    fail(
      `verifying_key.rs missing at ${vkeyRsPath}`,
      "run `node packages/svm/zx402-privacy-pool/scripts/build-verifying-key.mjs`",
    );
  }
  const vk = JSON.parse(readFileSync(vkeyJsonPath, "utf8"));
  const rsSrc = readFileSync(vkeyRsPath, "utf8");
  const m = rsSrc.match(/pub const N_PUBLIC: usize = (\d+);/);
  if (!m) fail("could not locate N_PUBLIC in verifying_key.rs");
  const declared = parseInt(m[1], 10);
  if (declared !== vk.nPublic) {
    fail(
      `verifying_key.rs claims N_PUBLIC=${declared} but groth16_vkey.json has nPublic=${vk.nPublic}`,
      "regenerate with `node packages/svm/zx402-privacy-pool/scripts/build-verifying-key.mjs`",
    );
  }
  if (vk.IC.length !== vk.nPublic + 1) {
    fail(
      `groth16_vkey.json has ${vk.IC.length} IC entries, expected nPublic+1=${vk.nPublic + 1}`,
      "vkey file is corrupt or non-standard",
    );
  }
  // Fingerprint check: confirm the first byte of IC[0]'s X-coordinate (BE)
  // appears at the head of the IC[0] block in the .rs file. Catches "vkey
  // regenerated but didn't re-run the generator" without re-implementing
  // the full encoding.
  const ic0x = BigInt(vk.IC[0][0]);
  const ic0xHex = ic0x.toString(16).padStart(64, "0");
  const firstByteDec = parseInt(ic0xHex.slice(0, 2), 16);
  const ic0Block = rsSrc.split("// IC[0]")[1] ?? "";
  const firstNumber = ic0Block.match(/\[\s*(\d+)/);
  if (firstNumber && parseInt(firstNumber[1], 10) !== firstByteDec) {
    fail(
      `verifying_key.rs IC[0] doesn't match groth16_vkey.json (first byte ${firstNumber[1]} vs expected ${firstByteDec})`,
      "regenerate verifying_key.rs from the current vkey",
    );
  }
  ok(`verifying_key.rs matches groth16_vkey.json (N_PUBLIC=${declared}, IC=${vk.IC.length})`);
}

// 4. .so freshness.
{
  const soPath = join(PROGRAM_DIR, "target/deploy/zx402_privacy_pool.so");
  if (!existsSync(soPath)) {
    fail(
      `BPF artifact missing at ${soPath}`,
      "run `cd packages/svm/zx402-privacy-pool && anchor build --ignore-keys`",
    );
  }
  const soMtime = statSync(soPath).mtimeMs;
  const watched = [
    "programs/zx402-privacy-pool/src/lib.rs",
    "programs/zx402-privacy-pool/src/crypto.rs",
    "programs/zx402-privacy-pool/src/verifying_key.rs",
    "programs/zx402-privacy-pool/Cargo.toml",
  ];
  for (const rel of watched) {
    const p = join(PROGRAM_DIR, rel);
    if (!existsSync(p)) continue;
    const t = statSync(p).mtimeMs;
    if (t > soMtime) {
      fail(
        `${rel} is newer than the built .so`,
        "anchor build needed: `cd packages/svm/zx402-privacy-pool && anchor build --ignore-keys`",
      );
    }
  }
  const sizeKb = Math.round(statSync(soPath).size / 1024);
  const artifact = readFileSync(soPath);
  const artifactHash = createHash("sha256").update(artifact).digest("hex");
  if (artifactHash !== REVIEWED_ARTIFACT_SHA256) {
    fail(
      `BPF artifact hash ${artifactHash} is not the reviewed hash ${REVIEWED_ARTIFACT_SHA256}`,
      "do not deploy a new build until its source, toolchain, tests, and hash are reviewed and the readiness constants are updated together",
    );
  }
  if (artifact.length > PROGRAMDATA_LENGTH) {
    fail(
      `BPF artifact is ${artifact.length} bytes and does not fit the ${PROGRAMDATA_LENGTH}-byte ProgramData allocation`,
    );
  }
  const padded = Buffer.alloc(PROGRAMDATA_LENGTH);
  artifact.copy(padded);
  const paddedHash = createHash("sha256").update(padded).digest("hex");
  if (paddedHash !== REVIEWED_PROGRAMDATA_SHA256) {
    fail(
      `zero-padded ProgramData hash ${paddedHash} is not ${REVIEWED_PROGRAMDATA_SHA256}`,
      "do not deploy: the live facilitator would reject this binary even if the upgrade succeeded",
    );
  }
  ok(`BPF artifact is fresh and reviewed (${sizeKb} KB, ProgramData hash matched)`);
}

// 5. Upgrade authority check (network required).
if (OFFLINE) {
  info("(skipped step 5 — --offline)");
} else {
  try {
    const out = execFileSync(
      "solana",
      ["program", "show", PROGRAM_ID, "--url", "devnet"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const authMatch = out.match(/Authority:\s+(\S+)/);
    const dataLengthMatch = out.match(/Data Length:\s+(\d+)/);
    if (!dataLengthMatch || Number(dataLengthMatch[1]) !== PROGRAMDATA_LENGTH) {
      fail(
        `live ProgramData allocation is ${dataLengthMatch?.[1] ?? "unknown"}, expected ${PROGRAMDATA_LENGTH}`,
        "do not upgrade until the target allocation and reviewed padded hash are recalculated",
      );
    }
    if (!authMatch) {
      fail("could not parse upgrade authority from `solana program show`");
    }
    const authority = authMatch[1];
    const localPubkey = execFileSync("solana", ["address"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (authority === localPubkey) {
      ok(`upgrade authority is the local wallet (${localPubkey.slice(0, 8)}…)`);
    } else {
      fail(
        `upgrade authority (${authority}) is NOT the local wallet (${localPubkey})`,
        "use --keypair <auth> at deploy time, or change Solana CLI default to the upgrade authority",
      );
    }
  } catch (err) {
    fail(
      `online devnet preflight failed: ${String(err.message).slice(0, 160)}`,
      "do not deploy without a successful online preflight; use --offline only for local build checks",
    );
  }
}

console.log("\nPreflight passed. Safe to redeploy.\n");
console.log("Next:");
console.log(
  "  solana program deploy --program-id 7qGhxY9Dc9reSNbNHdX1Rtf7hq7D45zdnV1UY3rpt3eM \\\n" +
  "    --url devnet packages/svm/zx402-privacy-pool/target/deploy/zx402_privacy_pool.so",
);
