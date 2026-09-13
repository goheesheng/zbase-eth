/**
 * scripts/reclaim-seed-pools.ts — Post-lock-period treasury reclaim (Shipment B.3).
 *
 * Decrypts the seed-notes file, then for each unspent note generates a
 * Groth16 withdrawal proof (via the existing /api/withdraw route) that pays
 * the treasury address. Logs reclaim tx hashes and updates the encrypted
 * file in place so partial runs are resumable.
 *
 * SAFETY:
 *   - Refuses to run before config.lockUntil (override with --i-understand
 *     ONLY for testing on devnets; the prod entrypoint check is real).
 *   - Refuses to run if config.treasury differs from --recipient (you must
 *     opt in to a non-treasury reclaim address).
 *   - The withdrawal nullifier is one-shot; once burned the note can never
 *     be re-spent. The commitment remains in the on-chain Merkle tree
 *     forever, so the anonymity set is NOT shrunk by reclaim.
 *
 * Usage:
 *   tsx scripts/reclaim-seed-pools.ts
 *   tsx scripts/reclaim-seed-pools.ts --config path.json --api http://localhost:3009
 *   tsx scripts/reclaim-seed-pools.ts --dry-run
 *   tsx scripts/reclaim-seed-pools.ts --i-understand-pre-lock   # dev only
 *
 * Required env:
 *   ZBASE_SEED_ENCRYPTION_KEY   — 32-byte hex
 *   (The /api/withdraw server must already have POSTMAN_PRIVATE_KEY etc.)
 */

import "./load-env";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { argv, env, exit, cwd } from "node:process";
import { createDecipheriv, createHash } from "node:crypto";
import {
  loadConfig,
  type SeedNote,
  type EncryptedNotesFile,
  writeEncryptedNotes,
} from "./seed-pools.ts";

interface ReclaimArgs {
  dryRun: boolean;
  configPath?: string;
  apiUrl: string;
  recipient?: string;
  bypassLock: boolean;
}

function parseArgs(args: string[]): ReclaimArgs {
  let dryRun = false;
  let configPath: string | undefined;
  let apiUrl = env.ZBASE_API_URL ?? "http://localhost:3009";
  let recipient: string | undefined;
  let bypassLock = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--config") configPath = args[++i];
    else if (a.startsWith("--config=")) configPath = a.slice("--config=".length);
    else if (a === "--api") apiUrl = args[++i];
    else if (a.startsWith("--api=")) apiUrl = a.slice("--api=".length);
    else if (a === "--recipient") recipient = args[++i];
    else if (a.startsWith("--recipient=")) recipient = a.slice("--recipient=".length);
    else if (a === "--i-understand-pre-lock") bypassLock = true;
  }
  return { dryRun, configPath, apiUrl, recipient, bypassLock };
}

export function decryptNotes(file: EncryptedNotesFile, hexKey: string): SeedNote[] {
  if (file.cipher !== "aes-256-gcm") {
    throw new Error(`Unsupported cipher: ${file.cipher}`);
  }
  if (!/^[0-9a-fA-F]{64}$/.test(hexKey)) {
    throw new Error("ZBASE_SEED_ENCRYPTION_KEY must be 64 hex chars (32 bytes).");
  }
  const key = Buffer.from(hexKey, "hex");
  const iv = Buffer.from(file.iv, "base64");
  const authTag = Buffer.from(file.authTag, "base64");
  const ciphertext = Buffer.from(file.ciphertext, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
    "utf8",
  );
  const expectedHash = createHash("sha256").update(plaintext, "utf8").digest("hex");
  if (expectedHash !== file.plaintextHash) {
    throw new Error("plaintextHash mismatch: file tampered after encryption");
  }
  return JSON.parse(plaintext) as SeedNote[];
}

function banner(s: string) {
  console.log("\n" + "=".repeat(70));
  console.log(s);
  console.log("=".repeat(70));
}

async function main() {
  const args = parseArgs(argv.slice(2));
  const { config } = loadConfig(args.configPath);
  const recipient = args.recipient ?? config.treasury;

  banner(`zBase Seed Reclaim — ${args.dryRun ? "DRY RUN" : "LIVE"}`);
  console.log(`  Recipient:    ${recipient}`);
  console.log(`  Lock until:   ${config.lockUntil}`);
  console.log(`  Now:          ${new Date().toISOString()}`);
  console.log(`  API:          ${args.apiUrl}`);

  // ── Lock check ──
  const lockMs = Date.parse(config.lockUntil);
  const now = Date.now();
  if (now < lockMs) {
    const remainingDays = Math.ceil((lockMs - now) / 86_400_000);
    if (!args.bypassLock) {
      console.error(
        `\nREFUSING TO RECLAIM: lock period active. ~${remainingDays} day(s) remaining.\n` +
          `Override with --i-understand-pre-lock ONLY for devnet testing.`,
      );
      exit(2);
    }
    console.warn(
      `\nWARNING: --i-understand-pre-lock — bypassing lock (${remainingDays} day(s) early).`,
    );
  }

  // ── Recipient sanity ──
  if (recipient.toLowerCase() !== config.treasury.toLowerCase() && !args.bypassLock) {
    console.error(
      `\nREFUSING TO RECLAIM TO A NON-TREASURY ADDRESS.\n` +
        `Pass --i-understand-pre-lock with --recipient to acknowledge this is intentional.`,
    );
    exit(2);
  }

  // ── Load + decrypt ──
  const notesPath = isAbsolute(config.encryptedNotesPath)
    ? config.encryptedNotesPath
    : join(cwd(), config.encryptedNotesPath);
  if (!existsSync(notesPath)) {
    throw new Error(`Encrypted notes file not found: ${notesPath}`);
  }
  const encKey = env.ZBASE_SEED_ENCRYPTION_KEY;
  if (!encKey) throw new Error("Missing ZBASE_SEED_ENCRYPTION_KEY");
  const file = JSON.parse(readFileSync(notesPath, "utf8")) as EncryptedNotesFile;
  const notes = decryptNotes(file, encKey);

  const unspent = notes.filter((n) => !n.reclaimed);
  banner(`PLAN — ${unspent.length} unspent / ${notes.length} total`);

  // Group by pool for output sanity.
  const byPool = new Map<string, SeedNote[]>();
  for (const n of unspent) {
    const arr = byPool.get(n.poolAddress) ?? [];
    arr.push(n);
    byPool.set(n.poolAddress, arr);
  }
  for (const [pool, ns] of byPool) {
    let total = 0n;
    for (const n of ns) total += BigInt(n.valueAtomic);
    console.log(`  ${pool}  notes=${ns.length}  total_value=${total.toString()}`);
  }

  if (args.dryRun) {
    banner("DRY RUN — no withdrawals submitted");
    return;
  }

  if (unspent.length === 0) {
    console.log("\nNothing to reclaim. All notes already marked spent.");
    return;
  }

  // ── Reclaim loop ──
  banner("RECLAIM");
  let ok = 0;
  let failed = 0;
  for (let i = 0; i < unspent.length; i++) {
    const note = unspent[i];
    const label = `[${i + 1}/${unspent.length}] ${note.denomLabel} commit=${note.commitment.slice(0, 14)}...`;
    try {
      // Lock period over, so we waive the FIFO delay window for old notes.
      const url = `${args.apiUrl.replace(/\/$/, "")}/api/withdraw?fast=true`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nullifier: note.nullifier,
          secret: note.secret,
          value: note.valueAtomic,
          label: note.label,
          commitment: note.commitment,
          recipient,
          amountAtomic: note.valueAtomic,
          depositTimestamp: note.timestamp,
        }),
      });
      const data = (await res.json()) as {
        success?: boolean;
        txHash?: string;
        error?: string;
        debug?: unknown;
      };
      if (!res.ok || !data.success) {
        failed++;
        console.error(`  ${label} FAILED status=${res.status} err=${data.error ?? "unknown"}`);
        continue;
      }
      ok++;
      console.log(`  ${label} OK tx=${data.txHash}`);
      // Mark spent + persist (resumable).
      const indexInAll = notes.findIndex((n) => n.commitment === note.commitment);
      if (indexInAll >= 0) {
        notes[indexInAll] = {
          ...notes[indexInAll],
          reclaimed: true,
          reclaimedTxHash: data.txHash,
          reclaimedAt: Date.now(),
        };
        writeEncryptedNotes(config, notes, encKey);
      }
    } catch (err) {
      failed++;
      console.error(`  ${label} EXCEPTION ${(err as Error).message}`);
    }
  }

  banner("DONE");
  console.log(`  Reclaimed: ${ok}`);
  console.log(`  Failed:    ${failed}`);
  console.log(`  Skipped (already reclaimed in prior runs): ${notes.length - unspent.length}`);
  console.log(
    `\n  NOTE: failed entries are still spendable — re-run the script. The notes file\n` +
      `  is updated atomically after each successful reclaim.`,
  );
}

const isDirectRun = (() => {
  try {
    const entry = argv[1] ?? "";
    return (
      entry.endsWith("/reclaim-seed-pools.ts") ||
      entry.endsWith("/reclaim-seed-pools.js") ||
      entry.endsWith("\\reclaim-seed-pools.ts") ||
      entry.endsWith("\\reclaim-seed-pools.js")
    );
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main().catch((err) => {
    console.error("\nFATAL:", err.message);
    exit(1);
  });
}
