/**
 * Local-validator E2E for atomic private payment into a native Solana program.
 *
 * The validator must preload both SBF artifacts. The test creates a fresh mint,
 * pool, note, payment intent, and PDA-owned recipient ATA; builds a real
 * Groth16 proof; then submits one receiver instruction that CPIs into the pool.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
// @ts-expect-error bn.js ships without declarations in this workspace.
import BN from "bn.js";
import {
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
  SystemProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotent,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { buildMerkleTree, feToBE32 } from "@zbase-protocol/core";
import {
  deriveSvmRecipientTokenAccount,
  SvmPool,
  validatePreparedSvmPayment,
} from "../packages/svm/sdk/src/index.js";

const ACK = "I_ACKNOWLEDGE_LOCAL_VALIDATOR_WRITES";
if (process.env.ZX402_ALLOW_LOCAL_WRITES !== ACK) {
  throw new Error(
    `This test creates local-validator state. Set ZX402_ALLOW_LOCAL_WRITES=${ACK} to continue.`,
  );
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RPC_URL = process.env.SOLANA_RPC_URL || "http://127.0.0.1:18899";
const PRIVACY_POOL_PROGRAM_ID = new PublicKey(
  "7qGhxY9Dc9reSNbNHdX1Rtf7hq7D45zdnV1UY3rpt3eM",
);
const RECEIVER_PROGRAM_ID = new PublicKey(
  "8NZ1DwqbnTuTR2k1mAmsRFxQHBYkQgYs5UHaGD7onAmy",
);
const PAYMENT_AMOUNT = "5000";

function readOperator(): Keypair {
  const keypairPath =
    process.env.ZX402_RELAYER_KEYPAIR_PATH ||
    path.join(os.homedir(), ".config/solana/id.json");
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf8"))),
  );
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const operator = readOperator();
  const buyer = Keypair.generate();
  const merchant = Keypair.generate();
  const circuitsUrl = path.join(ROOT, "public", "circuits");

  for (const programId of [PRIVACY_POOL_PROGRAM_ID, RECEIVER_PROGRAM_ID]) {
    const account = await connection.getAccountInfo(programId);
    if (!account?.executable) {
      throw new Error(`program ${programId.toBase58()} is not loaded on ${RPC_URL}`);
    }
  }
  if ((await connection.getBalance(operator.publicKey)) < 0.2 * LAMPORTS_PER_SOL) {
    throw new Error("local validator operator needs at least 0.2 SOL");
  }
  const airdrop = await connection.requestAirdrop(buyer.publicKey, 0.2 * LAMPORTS_PER_SOL);
  await connection.confirmTransaction(airdrop, "confirmed");

  const mint = await createMint(connection, operator, operator.publicKey, null, 6);
  const buyerAta = await createAssociatedTokenAccountIdempotent(
    connection,
    operator,
    mint,
    buyer.publicKey,
  );
  await mintTo(connection, operator, mint, buyerAta, operator, 1_000_000);

  const buyerPool = new SvmPool({
    connection,
    wallet: buyer,
    relayer: operator.publicKey,
    network: "devnet",
    usdcMint: mint,
    circuitsUrl,
  });
  await buyerPool.initializePool(buyer.publicKey);
  const deposit = await buyerPool.deposit("1.0");

  const buyerProvider = new AnchorProvider(connection, new Wallet(buyer), {
    commitment: "confirmed",
  });
  const poolIdl = JSON.parse(
    fs.readFileSync(path.join(ROOT, "packages/svm/sdk/src/idl.json"), "utf8"),
  );
  const receiverIdl = JSON.parse(
    fs.readFileSync(
      path.join(
        ROOT,
        "packages/svm/zx402-privacy-pool/target/idl/zx402_native_receiver.json",
      ),
      "utf8",
    ),
  );
  const poolProgram = new Program(poolIdl, buyerProvider);
  const receiverProgram = new Program(receiverIdl, buyerProvider);
  const [poolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), mint.toBuffer()],
    PRIVACY_POOL_PROGRAM_ID,
  );
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), poolPda.toBuffer()],
    PRIVACY_POOL_PROGRAM_ID,
  );
  const aspTree = buildMerkleTree([BigInt(deposit.secrets.label)]);
  await poolProgram.methods
    .updateAspRoot(Array.from(feToBE32(aspTree.root)), "test:single-label")
    .accounts({ poolState: poolPda, postman: buyer.publicKey })
    .rpc();

  const orderId = Array.from(Keypair.generate().publicKey.toBytes());
  const [paymentIntent] = PublicKey.findProgramAddressSync(
    [Buffer.from("intent"), merchant.publicKey.toBuffer(), Buffer.from(orderId)],
    RECEIVER_PROGRAM_ID,
  );
  const [recipientAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("recipient"), paymentIntent.toBuffer()],
    RECEIVER_PROGRAM_ID,
  );
  if (PublicKey.isOnCurve(recipientAuthority.toBytes())) {
    throw new Error("receiver authority must be an off-curve PDA");
  }
  const recipientAta = deriveSvmRecipientTokenAccount(mint, recipientAuthority);
  if (!recipientAta.equals(getAssociatedTokenAddressSync(mint, recipientAuthority, true))) {
    throw new Error("SDK did not derive the canonical PDA-owned ATA");
  }

  const merchantProvider = new AnchorProvider(connection, new Wallet(merchant), {
    commitment: "confirmed",
  });
  const merchantReceiver = new Program(receiverIdl, merchantProvider);
  const merchantAirdrop = await connection.requestAirdrop(
    merchant.publicKey,
    0.1 * LAMPORTS_PER_SOL,
  );
  await connection.confirmTransaction(merchantAirdrop, "confirmed");
  await merchantReceiver.methods
    .createPaymentIntent(orderId, new BN(PAYMENT_AMOUNT))
    .accounts({
      paymentIntent,
      recipientAuthority,
      merchant: merchant.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  await createAssociatedTokenAccountIdempotent(
    connection,
    operator,
    mint,
    recipientAuthority,
    undefined,
    TOKEN_PROGRAM_ID,
    undefined,
    true,
  );
  const relayerAta = await createAssociatedTokenAccountIdempotent(
    connection,
    operator,
    mint,
    operator.publicKey,
  );

  const prepared = await buyerPool.prepareWithdrawal(
    deposit.secrets,
    recipientAuthority.toBase58(),
    PAYMENT_AMOUNT,
    operator.publicKey.toBase58(),
  );
  const validated = validatePreparedSvmPayment(prepared.payment, {
    network: buyerPool.networkId,
    programId: buyerPool.programAddress,
    pool: buyerPool.poolAddress,
    tokenMint: buyerPool.tokenMintAddress,
    relayer: operator.publicKey.toBase58(),
    recipient: recipientAuthority.toBase58(),
    amount: PAYMENT_AMOUNT,
    maxRelayFeeBps: 0n,
  });
  const [nullifierRecord] = PublicKey.findProgramAddressSync(
    [Buffer.from("nullifier"), poolPda.toBuffer(), Buffer.from(validated.nullifierHash)],
    PRIVACY_POOL_PROGRAM_ID,
  );
  const operatorProvider = new AnchorProvider(connection, new Wallet(operator), {
    commitment: "confirmed",
  });
  const operatorReceiver = new Program(receiverIdl, operatorProvider);
  const receiverInstruction = await operatorReceiver.methods
    .fulfillPrivatePayment(
      orderId,
      Array.from(validated.nullifierHash),
      {
        nullifierHash: Array.from(validated.nullifierHash),
        recipient: validated.recipient,
        withdrawnValue: new BN(validated.amount.toString()),
        relayFeeBps: new BN(validated.relayFeeBps.toString()),
        withdrawalData: Buffer.from(validated.withdrawalData),
        proofA: Array.from(validated.proofA),
        proofB: Array.from(validated.proofB),
        proofC: Array.from(validated.proofC),
        publicInputs: validated.publicInputs,
      },
    )
    .accounts({
      paymentIntent,
      recipientAuthority,
      recipientTokenAccount: recipientAta,
      poolState: poolPda,
      nullifierRecord,
      vault: vaultPda,
      relayerTokenAccount: relayerAta,
      relayer: operator.publicKey,
      privacyPoolProgram: PRIVACY_POOL_PROGRAM_ID,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  const [createLookupInstruction, lookupTableAddress] =
    AddressLookupTableProgram.createLookupTable({
      authority: operator.publicKey,
      payer: operator.publicKey,
      recentSlot: await connection.getSlot("finalized"),
    });
  const extendLookupInstruction = AddressLookupTableProgram.extendLookupTable({
    payer: operator.publicKey,
    authority: operator.publicKey,
    lookupTable: lookupTableAddress,
    addresses: [
      paymentIntent,
      recipientAuthority,
      recipientAta,
      poolPda,
      nullifierRecord,
      vaultPda,
      relayerAta,
      PRIVACY_POOL_PROGRAM_ID,
      RECEIVER_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      SystemProgram.programId,
    ],
  });
  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(createLookupInstruction, extendLookupInstruction),
    [operator],
  );
  // A lookup table created in the current slot becomes usable after the bank
  // advances. Two small airdrop confirmations avoid wall-clock sleeps.
  for (let index = 0; index < 2; index += 1) {
    const advance = await connection.requestAirdrop(Keypair.generate().publicKey, 1);
    await connection.confirmTransaction(advance, "confirmed");
  }
  const lookupTable = await connection.getAddressLookupTable(lookupTableAddress);
  if (!lookupTable.value) throw new Error("failed to create address lookup table");
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const message = new TransactionMessage({
    payerKey: operator.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }),
      receiverInstruction,
    ],
  }).compileToV0Message([lookupTable.value]);
  const transaction = new VersionedTransaction(message);
  transaction.sign([operator]);
  const signature = await connection.sendTransaction(transaction);
  await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    "confirmed",
  );

  const recipientBalance = await getAccount(connection, recipientAta);
  if (recipientBalance.amount !== BigInt(PAYMENT_AMOUNT)) {
    throw new Error(
      `PDA recipient received ${recipientBalance.amount}, expected ${PAYMENT_AMOUNT}`,
    );
  }
  const intentAccount = (
    receiverProgram.account as unknown as {
      paymentIntent: { fetch(address: PublicKey): Promise<unknown> };
    }
  ).paymentIntent;
  const intent = (await intentAccount.fetch(paymentIntent)) as {
    fulfilled: boolean;
    nullifierHash: number[];
    recipientAuthority: PublicKey;
  };
  if (!intent.fulfilled) throw new Error("payment intent was not fulfilled atomically");
  if (!intent.recipientAuthority.equals(recipientAuthority)) {
    throw new Error("payment intent recipient authority changed");
  }
  if (!Buffer.from(intent.nullifierHash).equals(Buffer.from(validated.nullifierHash))) {
    throw new Error("payment intent did not record the spent nullifier");
  }

  // Prove the post-CPI amount check is atomic, not just a happy-path assertion.
  // The proof transfers 5,000 units, while this second intent requires 5,001.
  // The receiver rejects after the pool CPI; Solana must then roll back the
  // recipient transfer, pool nullifier, and fulfillment state together.
  if (!prepared.nextDeposit) {
    throw new Error("first withdrawal did not create the change note needed for rollback test");
  }
  const rejectedOrderId = Array.from(Keypair.generate().publicKey.toBytes());
  const [rejectedIntent] = PublicKey.findProgramAddressSync(
    [Buffer.from("intent"), merchant.publicKey.toBuffer(), Buffer.from(rejectedOrderId)],
    RECEIVER_PROGRAM_ID,
  );
  const [rejectedRecipient] = PublicKey.findProgramAddressSync(
    [Buffer.from("recipient"), rejectedIntent.toBuffer()],
    RECEIVER_PROGRAM_ID,
  );
  const rejectedRecipientAta = deriveSvmRecipientTokenAccount(mint, rejectedRecipient);
  await merchantReceiver.methods
    .createPaymentIntent(rejectedOrderId, new BN("5001"))
    .accounts({
      paymentIntent: rejectedIntent,
      recipientAuthority: rejectedRecipient,
      merchant: merchant.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  await createAssociatedTokenAccountIdempotent(
    connection,
    operator,
    mint,
    rejectedRecipient,
    undefined,
    TOKEN_PROGRAM_ID,
    undefined,
    true,
  );

  const rejectedPrepared = await buyerPool.prepareWithdrawal(
    prepared.nextDeposit,
    rejectedRecipient.toBase58(),
    PAYMENT_AMOUNT,
    operator.publicKey.toBase58(),
  );
  const rejectedValidated = validatePreparedSvmPayment(rejectedPrepared.payment, {
    network: buyerPool.networkId,
    programId: buyerPool.programAddress,
    pool: buyerPool.poolAddress,
    tokenMint: buyerPool.tokenMintAddress,
    relayer: operator.publicKey.toBase58(),
    recipient: rejectedRecipient.toBase58(),
    amount: PAYMENT_AMOUNT,
    maxRelayFeeBps: 0n,
  });
  const [rejectedNullifierRecord] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("nullifier"),
      poolPda.toBuffer(),
      Buffer.from(rejectedValidated.nullifierHash),
    ],
    PRIVACY_POOL_PROGRAM_ID,
  );
  const rejectedInstruction = await operatorReceiver.methods
    .fulfillPrivatePayment(
      rejectedOrderId,
      Array.from(rejectedValidated.nullifierHash),
      {
        nullifierHash: Array.from(rejectedValidated.nullifierHash),
        recipient: rejectedValidated.recipient,
        withdrawnValue: new BN(rejectedValidated.amount.toString()),
        relayFeeBps: new BN(rejectedValidated.relayFeeBps.toString()),
        withdrawalData: Buffer.from(rejectedValidated.withdrawalData),
        proofA: Array.from(rejectedValidated.proofA),
        proofB: Array.from(rejectedValidated.proofB),
        proofC: Array.from(rejectedValidated.proofC),
        publicInputs: rejectedValidated.publicInputs,
      },
    )
    .accounts({
      paymentIntent: rejectedIntent,
      recipientAuthority: rejectedRecipient,
      recipientTokenAccount: rejectedRecipientAta,
      poolState: poolPda,
      nullifierRecord: rejectedNullifierRecord,
      vault: vaultPda,
      relayerTokenAccount: relayerAta,
      relayer: operator.publicKey,
      privacyPoolProgram: PRIVACY_POOL_PROGRAM_ID,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  const extendRejectedAccounts = AddressLookupTableProgram.extendLookupTable({
    payer: operator.publicKey,
    authority: operator.publicKey,
    lookupTable: lookupTableAddress,
    addresses: [
      rejectedIntent,
      rejectedRecipient,
      rejectedRecipientAta,
      rejectedNullifierRecord,
    ],
  });
  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(extendRejectedAccounts),
    [operator],
  );
  for (let index = 0; index < 2; index += 1) {
    const advance = await connection.requestAirdrop(Keypair.generate().publicKey, 1);
    await connection.confirmTransaction(advance, "confirmed");
  }
  const extendedLookupTable = await connection.getAddressLookupTable(lookupTableAddress);
  if (!extendedLookupTable.value) throw new Error("failed to extend address lookup table");
  const rejectedLifetime = await connection.getLatestBlockhash();
  const rejectedMessage = new TransactionMessage({
    payerKey: operator.publicKey,
    recentBlockhash: rejectedLifetime.blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }),
      rejectedInstruction,
    ],
  }).compileToV0Message([extendedLookupTable.value]);
  const rejectedTransaction = new VersionedTransaction(rejectedMessage);
  rejectedTransaction.sign([operator]);

  let amountMismatchRejected = false;
  try {
    await connection.sendTransaction(rejectedTransaction);
  } catch (error) {
    const details = [
      error instanceof Error ? error.message : String(error),
      ...(((error as { logs?: string[] }).logs ?? [])),
    ].join("\n");
    if (!/IncorrectTokenDelta|0x1773/i.test(details)) throw error;
    amountMismatchRejected = true;
  }
  if (!amountMismatchRejected) {
    throw new Error("receiver accepted a pool transfer below the committed intent amount");
  }
  const rejectedBalance = await getAccount(connection, rejectedRecipientAta);
  if (rejectedBalance.amount !== 0n) {
    throw new Error("failed receiver instruction did not roll back recipient tokens");
  }
  if (await connection.getAccountInfo(rejectedNullifierRecord)) {
    throw new Error("failed receiver instruction did not roll back the pool nullifier");
  }
  const rejectedIntentState = (await intentAccount.fetch(rejectedIntent)) as {
    fulfilled: boolean;
  };
  if (rejectedIntentState.fulfilled) {
    throw new Error("failed receiver instruction committed fulfillment state");
  }

  console.log("NATIVE SOLANA PROGRAM PRIVATE PAYMENT E2E PASSED");
  console.log(`receiver: ${RECEIVER_PROGRAM_ID.toBase58()}`);
  console.log(`intent: ${paymentIntent.toBase58()}`);
  console.log(`recipient PDA: ${recipientAuthority.toBase58()}`);
  console.log(`recipient ATA: ${recipientAta.toBase58()}`);
  console.log(`settlement: ${signature}`);
  console.log(`received: ${recipientBalance.amount} atomic units`);
  console.log("amount-mismatch rollback: recipient=0, nullifier=absent, fulfilled=false");
  process.exit(0);
}

main().catch((error) => {
  console.error("NATIVE SOLANA PROGRAM PRIVATE PAYMENT E2E FAILED");
  console.error(error);
  process.exit(1);
});
