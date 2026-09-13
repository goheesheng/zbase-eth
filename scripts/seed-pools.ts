/**
 * scripts/seed-pools.ts — Anonymity-set bootstrapping script (Shipment B.3).
 *
 * Mirrors Vitalik Buterin's $113K personal seed of 0xbow Privacy Pools. Without
 * a seed, a 5-user pool is trivially de-anonymizable. This script makes N
 * deposits of each configured denomination from the treasury wallet, records
 * the resulting commitments + nullifiers (so the treasury can reclaim after
 * the lock period), and encrypts the secrets at rest with AES-256-GCM.
 *
 * Usage:
 *   tsx scripts/seed-pools.ts                # live run
 *   tsx scripts/seed-pools.ts --dry-run      # plan only, no on-chain tx
 *   tsx scripts/seed-pools.ts --config path/to.json
 *
 * Required env:
 *   TREASURY_PRIVATE_KEY        — signer for deposits (must match config.treasury)
 *   BASE_SEPOLIA_RPC            — RPC endpoint
 *   ZBASE_SEED_ENCRYPTION_KEY   — 32-byte hex (64 chars) for AES-256-GCM
 *
 * Output (live mode):
 *   <encryptedNotesPath>        — encrypted seed notes (gitignored)
 *   stdout                      — per-deposit tx hashes + running pool size
 *
 * Governance: per CLAUDE.md, the treasury can deposit freely; the entrypoint
 * is the audited 0xbow contract — no redeployment occurs. Multi-sig is only
 * required for protocol upgrades, not seeding deposits.
 */

import "./load-env";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { argv, env, exit, cwd } from "node:process";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  formatUnits,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { poseidon2 } from "poseidon-lite";

// ── Types ──────────────────────────────────────────────────────────────────

interface PoolConfig {
  address: string;
  asset: string;
  assetDecimals: number;
  label: string;
  /** Whole-token denomination -> count of commitments to mint. */
  denomCount: Record<string, number>;
}

interface SeedConfig {
  treasury: string;
  pools: PoolConfig[];
  /** ISO-8601 timestamp. Reclaim script refuses to run until after this. */
  lockUntil: string;
  encryptedNotesPath: string;
  entrypoint: string;
  chainId: number;
  /** ms to wait between deposits to spread block placement. Default 5000. */
  depositGapMs?: number;
}

export interface SeedNote {
  poolAddress: string;
  asset: string;
  denomLabel: string;
  /** Raw atomic amount sent to deposit() (pre-fee). */
  amountAtomic: string;
  /** On-chain post-fee value embedded in the commitment. */
  valueAtomic: string;
  /** Field elements as decimal strings. */
  nullifier: string;
  secret: string;
  label: string;
  commitment: string;
  precommitment: string;
  txHash: string;
  blockNumber: string;
  timestamp: number;
  depositor: string;
  reclaimed: boolean;
  reclaimedTxHash?: string;
  reclaimedAt?: number;
}

export interface EncryptedNotesFile {
  version: 1;
  cipher: "aes-256-gcm";
  /** ISO-8601. From config; reclaim script enforces. */
  lockUntil: string;
  treasury: string;
  /** Treasury MUST be told to NEVER touch these notes before lockUntil. */
  pools: Array<{ address: string; label: string; commitments: string[] }>;
  /** Public-side count, intentionally exposed for transparency tooling. */
  totalNotes: number;
  /** Base64-encoded ciphertext payload. */
  ciphertext: string;
  iv: string;
  authTag: string;
  /** SHA-256 of plaintext, for tamper detection AFTER decrypt. */
  plaintextHash: string;
  createdAt: number;
  notesByPool: Record<string, { denomCount: Record<string, number> }>;
}

// ── Constants ──────────────────────────────────────────────────────────────

const SNARK_FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const DEPOSITED_TOPIC =
  "0xe3b53cd1a44fbf11535e145d80b8ef1ed6d57a73bf5daa7e939b6b01657d6549";

const ERC20_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "address" }, { type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ type: "address" }, { type: "uint256" }],
    outputs: [{ type: "bool" }],
  },
] as const;

const DEPOSIT_ABI = [
  {
    name: "deposit",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_asset", type: "address" },
      { name: "_amount", type: "uint256" },
      { name: "_precommitment", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

// ── Helpers ────────────────────────────────────────────────────────────────

export function randomFieldElement(): bigint {
  const bytes = new Uint8Array(32);
  // crypto.getRandomValues exists in Node 19+ globally.
  crypto.getRandomValues(bytes);
  let result = 0n;
  for (const byte of bytes) {
    result = (result << 8n) + BigInt(byte);
  }
  return result % SNARK_FIELD;
}

export function parseLockUntil(iso: string): number {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) {
    throw new Error(`Invalid lockUntil ISO timestamp: ${iso}`);
  }
  return ms;
}

export function loadConfig(pathArg?: string): { config: SeedConfig; configPath: string } {
  const configPath = pathArg
    ? (isAbsolute(pathArg) ? pathArg : resolve(cwd(), pathArg))
    : resolve(cwd(), "scripts/seed-pools.config.json");

  if (!existsSync(configPath)) {
    throw new Error(`Config not found at ${configPath}`);
  }
  const raw = readFileSync(configPath, "utf8");
  const config = JSON.parse(raw) as SeedConfig;
  validateConfig(config);
  return { config, configPath };
}

function validateConfig(config: SeedConfig): void {
  if (!config.treasury?.startsWith("0x") || config.treasury.length !== 42) {
    throw new Error("config.treasury must be a 0x-prefixed 20-byte address");
  }
  if (!Array.isArray(config.pools) || config.pools.length === 0) {
    throw new Error("config.pools must be a non-empty array");
  }
  parseLockUntil(config.lockUntil); // throws if bad
  if (!config.encryptedNotesPath) {
    throw new Error("config.encryptedNotesPath is required");
  }
  for (const pool of config.pools) {
    if (!pool.address?.startsWith("0x")) {
      throw new Error(`pool.address invalid: ${pool.address}`);
    }
    if (!pool.asset?.startsWith("0x")) {
      throw new Error(`pool.asset invalid: ${pool.asset}`);
    }
    if (typeof pool.assetDecimals !== "number" || pool.assetDecimals < 0) {
      throw new Error(`pool.assetDecimals must be a non-negative number`);
    }
    if (!pool.denomCount || Object.keys(pool.denomCount).length === 0) {
      throw new Error(`pool.denomCount must have at least one denomination`);
    }
    for (const [denom, count] of Object.entries(pool.denomCount)) {
      if (!/^\d+(\.\d+)?$/.test(denom)) {
        throw new Error(`denom key must be numeric (whole tokens), got: ${denom}`);
      }
      if (!Number.isInteger(count) || count < 0) {
        throw new Error(`denomCount[${denom}] must be a non-negative integer`);
      }
    }
  }
}

/**
 * Encrypts the plaintext seed-notes blob with AES-256-GCM. Key comes from
 * env `ZBASE_SEED_ENCRYPTION_KEY` (64-char hex / 32 bytes). The IV is a fresh
 * 12 bytes; the auth tag is appended separately so re-encryption is easy.
 *
 * IMPORTANT: this encryption protects notes AT REST on disk. Anyone with the
 * key can decrypt and reclaim the seed. Store the key in a hardware key
 * manager (1Password, HSM, etc.). Do NOT commit it.
 */
export function encryptNotes(
  plaintext: string,
  hexKey: string,
): { iv: string; authTag: string; ciphertext: string } {
  if (!/^[0-9a-fA-F]{64}$/.test(hexKey)) {
    throw new Error(
      "ZBASE_SEED_ENCRYPTION_KEY must be 64 hex chars (32 bytes). Generate with: openssl rand -hex 32",
    );
  }
  const key = Buffer.from(hexKey, "hex");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    ciphertext: enc.toString("base64"),
  };
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function ensureDir(filePath: string) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function parseArgs(args: string[]): { dryRun: boolean; configPath?: string } {
  let dryRun = false;
  let configPath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--config") configPath = args[++i];
    else if (a.startsWith("--config=")) configPath = a.slice("--config=".length);
  }
  return { dryRun, configPath };
}

function banner(s: string) {
  console.log("\n" + "=".repeat(70));
  console.log(s);
  console.log("=".repeat(70));
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const { dryRun, configPath } = parseArgs(argv.slice(2));
  const { config, configPath: resolvedPath } = loadConfig(configPath);

  banner(`zBase Anonymity-Set Seeder — ${dryRun ? "DRY RUN" : "LIVE"}`);
  console.log(`  Config:         ${resolvedPath}`);
  console.log(`  Treasury:       ${config.treasury}`);
  console.log(`  Entrypoint:     ${config.entrypoint}`);
  console.log(`  Lock until:     ${config.lockUntil}`);
  console.log(`  Encrypted out:  ${config.encryptedNotesPath}`);

  // Plan: count total deposits + cash required per pool.
  banner("PLAN");
  let totalDeposits = 0;
  const plan: Array<{
    pool: PoolConfig;
    deposits: Array<{ denom: string; amountAtomic: bigint }>;
    totalAtomic: bigint;
  }> = [];

  for (const pool of config.pools) {
    const deposits: Array<{ denom: string; amountAtomic: bigint }> = [];
    let totalAtomic = 0n;
    for (const [denom, count] of Object.entries(pool.denomCount)) {
      const amountAtomic = parseUnits(denom, pool.assetDecimals);
      for (let i = 0; i < count; i++) {
        deposits.push({ denom, amountAtomic });
        totalAtomic += amountAtomic;
        totalDeposits++;
      }
    }
    plan.push({ pool, deposits, totalAtomic });
    console.log(
      `  ${pool.label}`,
    );
    console.log(
      `    deposits=${deposits.length}  total=${formatUnits(totalAtomic, pool.assetDecimals)} ${pool.label.split(" ")[0]}`,
    );
    for (const [denom, count] of Object.entries(pool.denomCount)) {
      console.log(`      ${count}x ${denom}`);
    }
  }
  console.log(`\n  TOTAL DEPOSITS: ${totalDeposits}`);

  if (dryRun) {
    banner("DRY RUN — no on-chain tx submitted");
    console.log("Plan is valid. Re-run without --dry-run to execute.");
    return;
  }

  // ── Validate env ──
  const rawKey = env.TREASURY_PRIVATE_KEY;
  const rpcUrl = env.BASE_SEPOLIA_RPC;
  const encKey = env.ZBASE_SEED_ENCRYPTION_KEY;

  if (!rawKey) throw new Error("Missing TREASURY_PRIVATE_KEY");
  if (!rpcUrl) throw new Error("Missing BASE_SEPOLIA_RPC");
  if (!encKey) throw new Error("Missing ZBASE_SEED_ENCRYPTION_KEY");
  if (!/^[0-9a-fA-F]{64}$/.test(encKey)) {
    throw new Error(
      "ZBASE_SEED_ENCRYPTION_KEY must be 64 hex chars. Generate: openssl rand -hex 32",
    );
  }

  const normalizedKey = rawKey.replace(/^0x/i, "");
  const account = privateKeyToAccount(`0x${normalizedKey}` as Hex);

  if (account.address.toLowerCase() !== config.treasury.toLowerCase()) {
    throw new Error(
      `TREASURY_PRIVATE_KEY address (${account.address}) does not match config.treasury (${config.treasury}). Refusing to proceed.`,
    );
  }

  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(rpcUrl),
  });
  const walletClient = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http("https://sepolia.base.org"),
  });

  banner("PRE-FLIGHT BALANCE CHECK");
  for (const { pool, totalAtomic } of plan) {
    const bal = (await publicClient.readContract({
      address: pool.asset as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [account.address],
    })) as bigint;
    console.log(
      `  ${pool.asset}  balance=${formatUnits(bal, pool.assetDecimals)}  need=${formatUnits(totalAtomic, pool.assetDecimals)}`,
    );
    if (bal < totalAtomic) {
      throw new Error(
        `Insufficient balance on ${pool.asset}. Need ${formatUnits(totalAtomic, pool.assetDecimals)}, have ${formatUnits(bal, pool.assetDecimals)}.`,
      );
    }
  }

  // ── Approve once per asset ──
  banner("APPROVALS");
  const approved = new Set<string>();
  for (const { pool, totalAtomic } of plan) {
    if (approved.has(pool.asset)) continue;
    const allowance = (await publicClient.readContract({
      address: pool.asset as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [account.address, config.entrypoint as `0x${string}`],
    })) as bigint;
    if (allowance < totalAtomic) {
      console.log(`  Approving max for ${pool.asset}...`);
      const tx = await walletClient.writeContract({
        address: pool.asset as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [config.entrypoint as `0x${string}`, 2n ** 256n - 1n],
      });
      await publicClient.waitForTransactionReceipt({ hash: tx });
      console.log(`    approve tx=${tx}`);
    } else {
      console.log(`  Already approved: ${pool.asset}`);
    }
    approved.add(pool.asset);
  }

  // ── Deposit loop ──
  banner("DEPOSITS");

  // Resume support: if the encrypted notes file already exists, decrypt and
  // load prior notes so a crashed run can pick up where it left off without
  // double-depositing. A typo'd key would silently wipe prior work, so we
  // refuse to start in that case.
  const allNotes: SeedNote[] = loadPriorNotesForResume(config, encKey);
  if (allNotes.length > 0) {
    console.log(
      `  RESUMING: loaded ${allNotes.length} prior deposits from ${config.encryptedNotesPath}`,
    );
  }

  // Track per-(pool, denom) deposits already on disk so the loop can skip
  // them. Decremented as each prior note is "consumed" by the loop.
  const remainingPriorByKey = new Map<string, number>();
  for (const n of allNotes) {
    const k = `${n.poolAddress.toLowerCase()}|${n.denomLabel}`;
    remainingPriorByKey.set(k, (remainingPriorByKey.get(k) ?? 0) + 1);
  }

  const depositGapMs = config.depositGapMs ?? 5000;
  let depositIdx = 0;

  for (const { pool, deposits } of plan) {
    for (const { denom, amountAtomic } of deposits) {
      depositIdx++;

      // Resume skip: if a prior note for this (pool, denom) is still
      // "unconsumed," treat this planned deposit as already done.
      const resumeKey = `${pool.address.toLowerCase()}|${denom}`;
      const remainingPrior = remainingPriorByKey.get(resumeKey) ?? 0;
      if (remainingPrior > 0) {
        remainingPriorByKey.set(resumeKey, remainingPrior - 1);
        console.log(
          `  [${depositIdx}/${totalDeposits}] SKIP — already in encrypted notes (${pool.label.split(" ")[0]} ${denom})`,
        );
        continue;
      }

      const nullifier = randomFieldElement();
      const secret = randomFieldElement();
      const precommitment = poseidon2([nullifier, secret]);

      const txHash = await walletClient.writeContract({
        address: config.entrypoint as `0x${string}`,
        abi: DEPOSIT_ABI,
        functionName: "deposit",
        args: [pool.asset as `0x${string}`, amountAtomic, precommitment],
        gas: 1_000_000n,
      });

      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== "success") {
        throw new Error(`Deposit ${depositIdx} reverted. tx=${txHash}`);
      }

      // Parse Deposited event from the pool to recover on-chain label + value.
      let onChainCommitment = 0n;
      let onChainLabel = 0n;
      let onChainValue = 0n;
      for (const eventLog of receipt.logs) {
        if (
          eventLog.address.toLowerCase() === pool.address.toLowerCase() &&
          eventLog.topics[0] === DEPOSITED_TOPIC
        ) {
          const data = eventLog.data as string;
          if (data.length >= 258) {
            onChainCommitment = BigInt("0x" + data.slice(2, 66));
            onChainLabel = BigInt("0x" + data.slice(66, 130));
            onChainValue = BigInt("0x" + data.slice(130, 194));
          }
          break;
        }
      }
      if (onChainLabel === 0n || onChainValue === 0n) {
        throw new Error(
          `Deposit ${depositIdx} succeeded but Deposited event not found. tx=${txHash}`,
        );
      }

      const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
      const note: SeedNote = {
        poolAddress: pool.address,
        asset: pool.asset,
        denomLabel: denom,
        amountAtomic: amountAtomic.toString(),
        valueAtomic: onChainValue.toString(),
        nullifier: nullifier.toString(),
        secret: secret.toString(),
        label: onChainLabel.toString(),
        commitment: onChainCommitment.toString(),
        precommitment: precommitment.toString(),
        txHash,
        blockNumber: receipt.blockNumber.toString(),
        timestamp: Number(block.timestamp),
        depositor: account.address,
        reclaimed: false,
      };
      allNotes.push(note);

      console.log(
        `  [${depositIdx}/${totalDeposits}] ${pool.label.split(" ")[0]} ${denom} tx=${txHash} commit=${onChainCommitment.toString().slice(0, 14)}...`,
      );

      // Persist after every successful deposit so a crash mid-run doesn't lose notes.
      writeEncryptedNotes(config, allNotes, encKey);

      if (depositIdx < totalDeposits && depositGapMs > 0) {
        await sleep(depositGapMs);
      }
    }
  }

  banner("DONE");
  console.log(`  Total deposits: ${allNotes.length}`);
  console.log(`  Encrypted notes: ${config.encryptedNotesPath}`);
  console.log(`  Lock until: ${config.lockUntil}`);
  console.log(`\n  NEXT STEPS:`);
  console.log(`    1. Back up the encrypted notes file off-host.`);
  console.log(`    2. Store ZBASE_SEED_ENCRYPTION_KEY in a hardware key manager.`);
  console.log(`    3. Update docs/anonymity-set-disclosure.md with the seed counts.`);
  console.log(`    4. After ${config.lockUntil}, run scripts/reclaim-seed-pools.ts.`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Decrypt prior seed notes from disk so the seeder can resume after a crash.
 * Returns [] if no file exists yet. Throws if the file exists but the key
 * cannot decrypt it — refusing to clobber prior notes with a typo'd key is a
 * deliberate safety property.
 */
export function loadPriorNotesForResume(
  config: SeedConfig,
  encKey: string,
): SeedNote[] {
  const outPath = isAbsolute(config.encryptedNotesPath)
    ? config.encryptedNotesPath
    : join(cwd(), config.encryptedNotesPath);
  if (!existsSync(outPath)) return [];

  const raw = readFileSync(outPath, "utf8");
  const file = JSON.parse(raw) as EncryptedNotesFile;
  if (file.cipher !== "aes-256-gcm") {
    throw new Error(
      `Refusing to resume: ${config.encryptedNotesPath} uses unsupported cipher ${file.cipher}`,
    );
  }

  const key = Buffer.from(encKey, "hex");
  const iv = Buffer.from(file.iv, "base64");
  const authTag = Buffer.from(file.authTag, "base64");
  const ciphertext = Buffer.from(file.ciphertext, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  let plaintext: string;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch (err) {
    throw new Error(
      `Refusing to resume: cannot decrypt ${config.encryptedNotesPath} with the current ZBASE_SEED_ENCRYPTION_KEY. ` +
        `If this is a new run, delete the file. If you typo'd the key, fix it. ${(err as Error).message}`,
    );
  }
  if (sha256Hex(plaintext) !== file.plaintextHash) {
    throw new Error(`Refusing to resume: ${config.encryptedNotesPath} tampered after encryption`);
  }
  return JSON.parse(plaintext) as SeedNote[];
}

export function writeEncryptedNotes(
  config: SeedConfig,
  notes: SeedNote[],
  encKey: string,
): EncryptedNotesFile {
  const plaintext = JSON.stringify(notes, null, 2);
  const { iv, authTag, ciphertext } = encryptNotes(plaintext, encKey);

  // Public-side commitments are also public on-chain, so we expose them in
  // the metadata for transparency tooling without weakening secrecy.
  const poolsMeta = config.pools.map((p) => ({
    address: p.address,
    label: p.label,
    commitments: notes.filter((n) => n.poolAddress === p.address).map((n) => n.commitment),
  }));
  const notesByPool: Record<string, { denomCount: Record<string, number> }> = {};
  for (const p of config.pools) {
    const counts: Record<string, number> = {};
    for (const n of notes.filter((n) => n.poolAddress === p.address)) {
      counts[n.denomLabel] = (counts[n.denomLabel] ?? 0) + 1;
    }
    notesByPool[p.address] = { denomCount: counts };
  }

  const file: EncryptedNotesFile = {
    version: 1,
    cipher: "aes-256-gcm",
    lockUntil: config.lockUntil,
    treasury: config.treasury,
    pools: poolsMeta,
    totalNotes: notes.length,
    ciphertext,
    iv,
    authTag,
    plaintextHash: sha256Hex(plaintext),
    createdAt: Date.now(),
    notesByPool,
  };

  const outPath = isAbsolute(config.encryptedNotesPath)
    ? config.encryptedNotesPath
    : join(cwd(), config.encryptedNotesPath);
  ensureDir(outPath);
  writeFileSync(outPath, JSON.stringify(file, null, 2), "utf8");
  return file;
}

// Run main when executed directly. Skip when imported by tests.
const isDirectRun = (() => {
  try {
    const entry = argv[1] ?? "";
    return (
      entry.endsWith("/seed-pools.ts") ||
      entry.endsWith("/seed-pools.js") ||
      entry.endsWith("\\seed-pools.ts") ||
      entry.endsWith("\\seed-pools.js")
    );
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main().catch((err) => {
    console.error("\nFATAL:", err.message);
    if (err.stack) console.error(err.stack.split("\n").slice(0, 8).join("\n"));
    exit(1);
  });
}
