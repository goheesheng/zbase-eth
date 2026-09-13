/**
 * End-to-end devnet test for the zx402 Solana privacy pool (V1).
 *
 * Exercises every cryptographic gate the program now enforces:
 *   1. Init pool (postman = the wallet, for testability).
 *   2. Mint a fresh test USDC + deposit 10 USDC. The on-chain program
 *      computes Poseidon(value, label, precommitment) and inserts into the
 *      LeanIMT, advancing `tree_root`.
 *   3. Postman publishes an ASP root that contains exactly our deposit's
 *      `label` (so the withdraw circuit can prove ASP membership).
 *   4. Generate a real Groth16 withdrawal proof off-chain via snarkjs.
 *   5. Submit `relay_withdrawal`. The program verifies the proof on-chain
 *      via groth16-solana (~200K CU), checks ASP root + context binding +
 *      state-root membership, marks nullifier spent, and pays the recipient.
 *   6. Register an agent (smoke test of the unrelated path).
 *
 * Prerequisites: `npm install` at repo root, `~/.config/solana/id.json`
 * funded on devnet, `anchor build` already executed (so target/idl exists).
 *
 * Run from `packages/svm/zx402-privacy-pool`:
 *   npx ts-node tests/devnet-test.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  Connection,
  LAMPORTS_PER_SOL,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  mintTo,
  getAccount,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import { BN } from "bn.js";
import { LeanIMT } from "@zk-kit/lean-imt";
import { poseidon1, poseidon2, poseidon3 } from "poseidon-lite";
import { keccak_256 } from "@noble/hashes/sha3";
// snarkjs has no types; the .d.ts in src/ covers the EVM frontend.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import * as snarkjs from "snarkjs";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROGRAM_ID = new PublicKey("7qGhxY9Dc9reSNbNHdX1Rtf7hq7D45zdnV1UY3rpt3eM");

const SNARK_SCALAR_FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const BN254_PRIME =
  21888242871839275222246405745257275088696311157297823662689037894645226208583n;

const TREE_DEPTH = 32;
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const CIRCUITS_DIR = path.join(REPO_ROOT, "public", "circuits");

// ---------- crypto helpers (mirror @zbase-protocol/core + on-chain crypto.rs) ----------

function feToBE32(value: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = value;
  if (v < 0n) throw new Error("feToBE32: negative");
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) throw new Error("feToBE32: value > 2^256");
  return out;
}

function beToBigInt(bytes: Uint8Array | number[]): bigint {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

function randomFE(): bigint {
  const bytes = new Uint8Array(32);
  crypto.randomFillSync(bytes);
  return beToBigInt(bytes) % SNARK_SCALAR_FIELD;
}

/** label = keccak256(scope_be32 || nonce_be8) % SNARK_FIELD */
function computeLabel(scope: bigint, nonce: number | bigint): bigint {
  const buf = new Uint8Array(32 + 8);
  feToBE32(scope).forEach((b, i) => (buf[i] = b));
  let n = BigInt(nonce);
  for (let i = 7; i >= 0; i--) {
    buf[32 + i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return beToBigInt(keccak_256(buf)) % SNARK_SCALAR_FIELD;
}

/** context = keccak256(pool_pda || withdrawal_data || scope_be32) % SNARK_FIELD */
function computeSvmContext(
  poolPda: PublicKey,
  withdrawalData: Uint8Array,
  scope: bigint,
): bigint {
  const buf = new Uint8Array(32 + withdrawalData.length + 32);
  buf.set(poolPda.toBytes(), 0);
  buf.set(withdrawalData, 32);
  buf.set(feToBE32(scope), 32 + withdrawalData.length);
  return beToBigInt(keccak_256(buf)) % SNARK_SCALAR_FIELD;
}

/** Pack the bytes the on-chain program will hash for context binding. */
function svmEncodeWithdrawalData(
  recipient: PublicKey,
  relayFeeBps: bigint,
  relayer: PublicKey,
): Uint8Array {
  const out = new Uint8Array(32 + 8 + 32);
  out.set(recipient.toBytes(), 0);
  let v = relayFeeBps;
  for (let i = 7; i >= 0; i--) {
    out[32 + i] = Number(v & 0xffn);
    v >>= 8n;
  }
  out.set(relayer.toBytes(), 40);
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function encodeProofForSolana(proof: any) {
  const ax = BigInt(proof.pi_a[0]);
  const ay = BigInt(proof.pi_a[1]);
  const ayNeg = (BN254_PRIME - (ay % BN254_PRIME)) % BN254_PRIME;
  const proofA = new Uint8Array(64);
  proofA.set(feToBE32(ax), 0);
  proofA.set(feToBE32(ayNeg), 32);

  // groth16-solana wants Fp2 in (c1, c0) order; snarkjs emits (c0, c1).
  // x.c1 || x.c0 || y.c1 || y.c0
  const proofB = new Uint8Array(128);
  proofB.set(feToBE32(BigInt(proof.pi_b[0][1])), 0);
  proofB.set(feToBE32(BigInt(proof.pi_b[0][0])), 32);
  proofB.set(feToBE32(BigInt(proof.pi_b[1][1])), 64);
  proofB.set(feToBE32(BigInt(proof.pi_b[1][0])), 96);

  const proofC = new Uint8Array(64);
  proofC.set(feToBE32(BigInt(proof.pi_c[0])), 0);
  proofC.set(feToBE32(BigInt(proof.pi_c[1])), 32);

  return { proofA, proofB, proofC };
}

function padSiblings(siblings: bigint[]): string[] {
  if (siblings.length > TREE_DEPTH) {
    throw new Error(`siblings length ${siblings.length} > ${TREE_DEPTH}`);
  }
  return [
    ...siblings.map((s) => s.toString()),
    ...Array(TREE_DEPTH - siblings.length).fill("0"),
  ];
}

// ---------- main ----------

async function main() {
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const walletKeypair = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(
        fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf8"),
      ),
    ),
  );

  console.log("=== zx402 Devnet Test (V1: real Groth16 verification) ===");
  console.log(`Wallet:  ${walletKeypair.publicKey.toBase58()}`);
  console.log(`Program: ${PROGRAM_ID.toBase58()}`);

  const balance = await connection.getBalance(walletKeypair.publicKey);
  console.log(`Balance: ${balance / LAMPORTS_PER_SOL} SOL\n`);
  if (balance < 0.1 * LAMPORTS_PER_SOL) {
    throw new Error("wallet needs at least 0.1 SOL on devnet — run `solana airdrop 1 --url devnet`");
  }

  const wallet = new anchor.Wallet(walletKeypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  const idl = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "target", "idl", "zx402_privacy_pool.json"), "utf8"),
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const program: any = new Program(idl, provider);

  // 1. Fresh USDC + ATA + 100 USDC for the depositor.
  console.log("[1] Setting up test USDC mint + ATA...");
  const usdcMint = await createMint(
    connection,
    walletKeypair,
    walletKeypair.publicKey,
    null,
    6,
  );
  console.log(`    mint: ${usdcMint.toBase58()}`);
  const depositorAta = await getAssociatedTokenAddress(usdcMint, walletKeypair.publicKey);
  await provider.sendAndConfirm(
    new anchor.web3.Transaction().add(
      createAssociatedTokenAccountInstruction(
        walletKeypair.publicKey,
        depositorAta,
        walletKeypair.publicKey,
        usdcMint,
      ),
    ),
  );
  await mintTo(
    connection,
    walletKeypair,
    usdcMint,
    depositorAta,
    walletKeypair,
    100_000_000,
  );

  // 2. Initialize pool.
  console.log("[2] Initializing pool...");
  const [poolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), usdcMint.toBuffer()],
    PROGRAM_ID,
  );
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), poolPda.toBuffer()],
    PROGRAM_ID,
  );
  await program.methods
    .initialize(new BN(50), new BN(100), new BN(1_000_000))
    .accounts({
      poolState: poolPda,
      vault: vaultPda,
      tokenMint: usdcMint,
      owner: walletKeypair.publicKey,
      postman: walletKeypair.publicKey,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();
  const poolState = await program.account.poolState.fetch(poolPda);
  const scope: bigint = beToBigInt(poolState.scope as number[]);
  console.log(`    pool: ${poolPda.toBase58()}`);
  console.log(`    scope: ${scope.toString().slice(0, 20)}...`);

  // 3. Deposit 10 USDC.
  console.log("[3] Depositing 10 USDC...");
  const nullifier = randomFE();
  const secret = randomFE();
  const precommitment = poseidon2([nullifier, secret]);
  const depositIndex = (poolState.depositCount as BN).toNumber();
  const indexBuffer = Buffer.alloc(8);
  indexBuffer.writeBigUInt64LE(BigInt(depositIndex));
  const [depositRecordPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("deposit"), poolPda.toBuffer(), indexBuffer],
    PROGRAM_ID,
  );

  const depositTx = await program.methods
    .deposit(Array.from(feToBE32(precommitment)), new BN(10_000_000))
    .accounts({
      poolState: poolPda,
      depositRecord: depositRecordPda,
      vault: vaultPda,
      depositorTokenAccount: depositorAta,
      depositor: walletKeypair.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log(`    tx: ${depositTx.slice(0, 16)}...`);

  const depositRecord = await program.account.depositRecord.fetch(depositRecordPda);
  const onChainLabel: bigint = beToBigInt(depositRecord.label as number[]);
  const onChainCommitment: bigint = beToBigInt(depositRecord.commitment as number[]);
  const netValue: bigint = BigInt((depositRecord.amount as BN).toString());

  // Sanity: the SDK's label/commitment derivations must match the on-chain ones.
  const expectedLabel = computeLabel(scope, depositIndex);
  if (expectedLabel !== onChainLabel) {
    throw new Error(`label mismatch: off-chain ${expectedLabel} vs on-chain ${onChainLabel}`);
  }
  const expectedCommitment = poseidon3([netValue, onChainLabel, precommitment]);
  if (expectedCommitment !== onChainCommitment) {
    throw new Error(
      `commitment mismatch: off-chain ${expectedCommitment} vs on-chain ${onChainCommitment}`,
    );
  }
  console.log(`    label/commitment match on-chain ✓`);

  // 4. Postman publishes an ASP root containing our label.
  console.log("[4] Postman publishing ASP root...");
  const aspTree = new LeanIMT<bigint>((a, b) => poseidon2([a, b]));
  aspTree.insert(onChainLabel);
  await program.methods
    .updateAspRoot(Array.from(feToBE32(aspTree.root)), "ipfs://test")
    .accounts({
      poolState: poolPda,
      postman: walletKeypair.publicKey,
    })
    .rpc();
  console.log(`    asp root: ${aspTree.root.toString().slice(0, 20)}...`);

  // 5. Build state Merkle tree from on-chain DepositRecord accounts.
  console.log("[5] Building state Merkle tree from on-chain deposits...");
  const allDeposits = await program.account.depositRecord.all([
    { memcmp: { offset: 8, bytes: poolPda.toBase58() } },
  ]);
  const sorted = [...allDeposits].sort(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (a: any, b: any) => a.account.index.toNumber() - b.account.index.toNumber(),
  );
  const stateTree = new LeanIMT<bigint>((a, b) => poseidon2([a, b]));
  for (const d of sorted) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stateTree.insert(beToBigInt((d as any).account.commitment));
  }
  // Confirm our state root matches the on-chain one.
  const updatedPool = await program.account.poolState.fetch(poolPda);
  const onChainStateRoot: bigint = beToBigInt(updatedPool.treeRoot as number[]);
  if (stateTree.root !== onChainStateRoot) {
    throw new Error(
      `state root mismatch: off-chain ${stateTree.root} vs on-chain ${onChainStateRoot}. ` +
        `LeanIMT replication is broken.`,
    );
  }
  console.log(`    state root match on-chain ✓ (depth=${stateTree.depth})`);

  // 6. Generate the Groth16 proof.
  console.log("[6] Generating Groth16 withdrawal proof (~10s)...");
  const recipient = Keypair.generate();
  // Create recipient ATA up front so the relay tx can pay it.
  const recipientAta = await getAssociatedTokenAddress(usdcMint, recipient.publicKey);
  await provider.sendAndConfirm(
    new anchor.web3.Transaction().add(
      createAssociatedTokenAccountInstruction(
        walletKeypair.publicKey,
        recipientAta,
        recipient.publicKey,
        usdcMint,
      ),
    ),
  );

  const withdrawalData = svmEncodeWithdrawalData(
    recipient.publicKey,
    0n,
    walletKeypair.publicKey,
  );
  const context = computeSvmContext(poolPda, withdrawalData, scope);

  const stateProof = stateTree.generateProof(0); // we're the only deposit
  const aspProof = aspTree.generateProof(0);
  const stateSiblings = (stateProof.siblings as (bigint | bigint[])[]).map((s) =>
    Array.isArray(s) ? s[0] : s,
  ) as bigint[];
  const aspSiblings = (aspProof.siblings as (bigint | bigint[])[]).map((s) =>
    Array.isArray(s) ? s[0] : s,
  ) as bigint[];

  const newNullifier = randomFE();
  const newSecret = randomFE();

  const circuitInputs = {
    withdrawnValue: netValue.toString(),
    stateRoot: stateTree.root.toString(),
    stateTreeDepth: stateTree.depth.toString(),
    ASPRoot: aspTree.root.toString(),
    ASPTreeDepth: aspTree.depth.toString(),
    context: context.toString(),
    label: onChainLabel.toString(),
    existingValue: netValue.toString(),
    existingNullifier: nullifier.toString(),
    existingSecret: secret.toString(),
    newNullifier: newNullifier.toString(),
    newSecret: newSecret.toString(),
    stateSiblings: padSiblings(stateSiblings),
    stateIndex: "0",
    ASPSiblings: padSiblings(aspSiblings),
    ASPIndex: "0",
  };

  const wasmPath = path.join(CIRCUITS_DIR, "withdraw", "withdraw.wasm");
  const zkeyPath = path.join(CIRCUITS_DIR, "withdraw", "groth16_pkey.zkey");
  const t0 = Date.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    circuitInputs,
    wasmPath,
    zkeyPath,
  );
  console.log(`    proof generated in ${Date.now() - t0}ms`);
  console.log(`    public signals: ${publicSignals.length} (expected 8)`);
  publicSignals.forEach((s: string, i: number) => {
    console.log(`    [test] pi[${i}] dec=${s}`);
  });

  // Local verify to catch input bugs before paying for an on-chain tx.
  const vkey = JSON.parse(
    fs.readFileSync(path.join(CIRCUITS_DIR, "withdraw", "groth16_vkey.json"), "utf8"),
  );
  const okLocal = await snarkjs.groth16.verify(vkey, publicSignals, proof);
  if (!okLocal) throw new Error("local proof verification failed; circuit inputs are wrong");
  console.log(`    local verification ✓`);

  // 7. Submit relay_withdrawal.
  console.log("[7] Submitting relay_withdrawal (on-chain Groth16 verify ~200K CU)...");
  const { proofA, proofB, proofC } = encodeProofForSolana(proof);
  const publicInputs: number[][] = (publicSignals as string[]).map((s: string) =>
    Array.from(feToBE32(BigInt(s))),
  );
  const nullifierHash = poseidon1([nullifier]);
  const nullifierHashBE = feToBE32(nullifierHash);
  const [nullifierPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("nullifier"), poolPda.toBuffer(), Buffer.from(nullifierHashBE)],
    PROGRAM_ID,
  );

  const relayTx = await program.methods
    .relayWithdrawal(
      Array.from(nullifierHashBE),
      recipient.publicKey,
      new BN(netValue.toString()),
      new BN(0),
      Buffer.from(withdrawalData),
      Array.from(proofA),
      Array.from(proofB),
      Array.from(proofC),
      publicInputs,
    )
    .accounts({
      poolState: poolPda,
      nullifierRecord: nullifierPda,
      vault: vaultPda,
      recipientTokenAccount: recipientAta,
      relayerTokenAccount: depositorAta,
      relayer: walletKeypair.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log(`    tx: ${relayTx.slice(0, 16)}...`);

  const recipientBalance = await getAccount(connection, recipientAta);
  const vaultAfter = await getAccount(connection, vaultPda);
  console.log(`    recipient: ${Number(recipientBalance.amount) / 1e6} USDC`);
  console.log(`    vault:     ${Number(vaultAfter.amount) / 1e6} USDC`);
  if (Number(recipientBalance.amount) === 0) {
    throw new Error("recipient never received USDC — relay_withdrawal failed silently");
  }

  console.log("\n=== ALL CHECKS PASSED ===");
  console.log(`deposit:    https://explorer.solana.com/tx/${depositTx}?cluster=devnet`);
  console.log(`withdraw:   https://explorer.solana.com/tx/${relayTx}?cluster=devnet`);
  console.log(`pool:       https://explorer.solana.com/address/${poolPda.toBase58()}?cluster=devnet`);
}

main().catch((err) => {
  console.error("\n!!! TEST FAILED !!!");
  console.error(err);
  process.exit(1);
});
