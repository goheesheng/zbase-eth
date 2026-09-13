/**
 * Discover every initialized PoolState account on the deployed
 * zx402_privacy_pool program and pause each one whose `owner` is the
 * local wallet. Used during SVM V0 to prevent deposits while the
 * cryptographic core is not yet implemented (see STATUS.md).
 *
 * Usage:
 *   ts-node scripts/pause-all-pools.ts                # report pools
 *   ts-node scripts/pause-all-pools.ts --pause        # actually pause them
 *
 * Requires: ANCHOR_PROVIDER_URL and ANCHOR_WALLET (or default ~/.config/solana/id.json).
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  Connection,
  Keypair,
  PublicKey,
  clusterApiUrl,
} from "@solana/web3.js";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";

const PROGRAM_ID = new PublicKey(
  "7qGhxY9Dc9reSNbNHdX1Rtf7hq7D45zdnV1UY3rpt3eM",
);

async function main() {
  const shouldPause = process.argv.includes("--pause");

  const walletPath =
    process.env.ANCHOR_WALLET ??
    path.join(os.homedir(), ".config/solana/id.json");
  const walletKeypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf8"))),
  );

  const rpcUrl = process.env.ANCHOR_PROVIDER_URL ?? clusterApiUrl("devnet");
  const connection = new Connection(rpcUrl, "confirmed");
  const provider = new AnchorProvider(
    connection,
    new Wallet(walletKeypair),
    { commitment: "confirmed" },
  );

  const idlCandidates = [
    path.join(__dirname, "..", "target", "idl", "zx402_privacy_pool.json"),
    path.join(__dirname, "..", "..", "sdk", "src", "idl.json"),
  ];
  const idlPath = idlCandidates.find((p) => fs.existsSync(p));
  if (!idlPath) {
    console.error(
      `IDL not found. Tried:\n  ${idlCandidates.join("\n  ")}\nRun \`anchor build\` from packages/svm/zx402-privacy-pool first.`,
    );
    process.exit(1);
  }
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  // @ts-expect-error: anchor 0.30 Program ctor accepts (idl, provider)
  const program = new Program(idl, provider);

  console.log(`Program: ${PROGRAM_ID.toBase58()}`);
  console.log(`RPC:     ${rpcUrl}`);
  console.log(`Wallet:  ${walletKeypair.publicKey.toBase58()}`);
  console.log(`Mode:    ${shouldPause ? "PAUSE" : "REPORT (dry-run)"}`);
  console.log();

  // @ts-expect-error: account namespace is generated from IDL
  const pools = await program.account.poolState.all();
  if (pools.length === 0) {
    console.log("No PoolState accounts found. Nothing to do.");
    return;
  }

  let pausedCount = 0;
  let skippedNotOwner = 0;
  let skippedAlreadyPaused = 0;

  for (const entry of pools) {
    const pubkey = entry.publicKey as PublicKey;
    const acc = entry.account as {
      owner: PublicKey;
      paused: boolean;
      tokenMint: PublicKey;
      depositCount: { toString(): string };
    };
    const ownsThis = acc.owner.equals(walletKeypair.publicKey);
    console.log(`Pool ${pubkey.toBase58()}`);
    console.log(`  owner:        ${acc.owner.toBase58()}`);
    console.log(`  token mint:   ${acc.tokenMint.toBase58()}`);
    console.log(`  deposits:     ${acc.depositCount.toString()}`);
    console.log(`  paused:       ${acc.paused}`);
    console.log(`  this wallet owns it: ${ownsThis}`);

    if (!shouldPause) {
      console.log();
      continue;
    }

    if (acc.paused) {
      console.log("  -> already paused, skipping");
      skippedAlreadyPaused++;
      console.log();
      continue;
    }
    if (!ownsThis) {
      console.log("  -> not owner, cannot pause; skipping");
      skippedNotOwner++;
      console.log();
      continue;
    }

    try {
      // @ts-expect-error: methods namespace is generated from IDL
      const sig = await program.methods
        .setPaused(true)
        .accounts({
          poolState: pubkey,
          authority: walletKeypair.publicKey,
        })
        .rpc();
      console.log(`  -> paused. tx: ${sig}`);
      pausedCount++;
    } catch (err) {
      console.log(`  -> pause failed: ${(err as Error).message}`);
    }
    console.log();
  }

  if (shouldPause) {
    console.log(`Done. paused=${pausedCount} skipped(notOwner)=${skippedNotOwner} skipped(alreadyPaused)=${skippedAlreadyPaused}`);
  } else {
    console.log(
      "Dry-run complete. Re-run with --pause to actually pause pools you own.",
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
