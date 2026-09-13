/**
 * zBase Demo Bootstrap — provisions a stable test USDC mint + V1 pool that
 * the agent test reuses across runs. Each agent run deposits into the SAME
 * pool, so the on-chain anonymity set grows visibly run-by-run.
 *
 * Why this exists: Circle's devnet USDC has a V0 PoolState ghost squatting on
 * its PDA from earlier deploys, so we can't use it. Earlier the agent test
 * worked around this by minting a fresh test USDC every run — clean, but it
 * meant `pool-stats` always reported "no pools" cosmetically and every demo
 * appeared to start from zero. This bootstrap fixes that for the demo.
 *
 * Output: writes scripts/.demo-pool.json:
 *   {
 *     mint: "<test USDC mint pubkey>",
 *     pool: "<pool PDA>",
 *     postman: "<postman pubkey, = wallet>",
 *     createdAt: "<iso8601>",
 *     network: "devnet"
 *   }
 *
 * Idempotent: if the file exists AND the pool is reachable on-chain, skips
 * setup and reports the existing pool. Pass --reset to force a new pool.
 *
 * Usage:
 *   npm run demo:bootstrap          # one-time setup
 *   npm run demo:bootstrap -- --reset   # force fresh pool
 */

import "./load-env";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  createMint,
  createAssociatedTokenAccountIdempotent,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import BN from "bn.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(
  "7qGhxY9Dc9reSNbNHdX1Rtf7hq7D45zdnV1UY3rpt3eM",
);
const CONFIG_PATH = path.join(__dirname, ".demo-pool.json");
const DEMO_USDC_SUPPLY = 1_000_000_000; // 1000 USDC, enough for many runs.

const reset = process.argv.includes("--reset");

function log(emoji: string, msg: string) {
  console.log(`  ${emoji}  ${msg}`);
}

async function main() {
  const wallet = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(
        fs.readFileSync(
          path.join(os.homedir(), ".config/solana/id.json"),
          "utf8",
        ),
      ),
    ),
  );
  const connection = new Connection(RPC_URL, "confirmed");

  console.log(`\n╔══════════════════════════════════════════════════════════╗`);
  console.log(`║  zBase Demo Bootstrap — shared pool for repeated runs    ║`);
  console.log(`╚══════════════════════════════════════════════════════════╝\n`);
  log("🤖", `Wallet: ${wallet.publicKey.toBase58()}`);
  log("🛰", `RPC: ${RPC_URL}`);
  log("🛰", `Program: ${PROGRAM_ID.toBase58()}`);

  // --- Idempotency check ---
  if (!reset && fs.existsSync(CONFIG_PATH)) {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    log("📁", `Found existing config at ${path.basename(CONFIG_PATH)}`);
    log("🏊", `Pool: ${cfg.pool}`);
    try {
      const acc = await connection.getAccountInfo(new PublicKey(cfg.pool));
      if (acc && acc.owner.equals(PROGRAM_ID)) {
        log(
          "✅",
          `Pool exists on-chain (${acc.data.length} bytes). Nothing to do.`,
        );
        log("ℹ️", `Run with --reset to provision a new pool.`);
        return;
      }
      log("⚠️", `Pool not found on-chain — re-provisioning.`);
    } catch {
      log("⚠️", `Couldn't reach pool — re-provisioning.`);
    }
  }

  const idlPath = path.resolve(
    __dirname,
    "..",
    "packages/svm/zx402-privacy-pool/target/idl/zx402_privacy_pool.json",
  );
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  const provider = new AnchorProvider(connection, new Wallet(wallet), {
    commitment: "confirmed",
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const program = new Program(idl as any, provider);

  // --- 1. Create stable test USDC mint ---
  console.log(`\n--- STEP 1: Create stable test USDC mint ---\n`);
  log("⏳", `Creating test USDC mint (6 decimals, mint authority = wallet)…`);
  const testMint = await createMint(
    connection,
    wallet,
    wallet.publicKey,
    null,
    6,
  );
  log("✅", `Test mint: ${testMint.toBase58()}`);

  // --- 2. Mint supply to wallet's ATA ---
  console.log(`\n--- STEP 2: Mint demo USDC supply ---\n`);
  log("⏳", `Creating ATA + minting ${DEMO_USDC_SUPPLY / 1e6} USDC…`);
  const ata = await createAssociatedTokenAccountIdempotent(
    connection,
    wallet,
    testMint,
    wallet.publicKey,
  );
  await mintTo(connection, wallet, testMint, ata, wallet, DEMO_USDC_SUPPLY);
  log("✅", `Wallet now holds ${DEMO_USDC_SUPPLY / 1e6} test USDC.`);

  // --- 3. Initialize V1 pool against this mint ---
  console.log(`\n--- STEP 3: Initialize V1 pool ---\n`);
  const [poolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), testMint.toBuffer()],
    PROGRAM_ID,
  );
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), poolPda.toBuffer()],
    PROGRAM_ID,
  );
  log("⏳", `Initializing pool at ${poolPda.toBase58()}…`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const initTx = await (program as any).methods
    .initialize(new BN(50), new BN(100), new BN(1_000_000))
    .accounts({
      poolState: poolPda,
      vault: vaultPda,
      tokenMint: testMint,
      owner: wallet.publicKey,
      postman: wallet.publicKey,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();
  log("✅", `Pool initialized: ${initTx.slice(0, 16)}…`);
  log(
    "🔗",
    `Solscan: https://solscan.io/account/${poolPda.toBase58()}?cluster=devnet`,
  );

  // --- 4. Persist config ---
  const cfg = {
    mint: testMint.toBase58(),
    pool: poolPda.toBase58(),
    vault: vaultPda.toBase58(),
    postman: wallet.publicKey.toBase58(),
    network: "devnet" as const,
    createdAt: new Date().toISOString(),
    notes:
      "Demo pool for zBase agent test. Each agent run deposits into THIS pool — anonymity set grows over time.",
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");

  console.log(
    `\n╔══════════════════════════════════════════════════════════╗`,
  );
  console.log(`║                  BOOTSTRAP COMPLETE                      ║`);
  console.log(
    `╠══════════════════════════════════════════════════════════╣`,
  );
  console.log(`║  Mint:    ${testMint.toBase58().padEnd(46)}║`);
  console.log(`║  Pool:    ${poolPda.toBase58().padEnd(46)}║`);
  console.log(
    `║  Saved:   ${path.relative(process.cwd(), CONFIG_PATH).padEnd(46)}║`,
  );
  console.log(
    `║  Next:    npm run test:svm-x402-agent                       ║`,
  );
  console.log(
    `╚══════════════════════════════════════════════════════════╝\n`,
  );
}

main().catch((err) => {
  console.error("\n!!! BOOTSTRAP FAILED !!!");
  console.error(err);
  process.exit(1);
});
