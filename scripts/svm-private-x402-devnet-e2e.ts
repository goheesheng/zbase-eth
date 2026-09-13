/**
 * State-changing post-upgrade E2E for the private-exact SVM facilitator.
 *
 * This intentionally creates a fresh devnet mint, pool, deposit, and three
 * private payments. It refuses to run without an explicit acknowledgement.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotent,
  createMint,
  getAccount,
  mintTo,
} from "@solana/spl-token";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
} from "@x402/core/types";
import {
  PRIVATE_SVM_SCHEME,
  PrivateExactSvmClientScheme,
  SOLANA_DEVNET_CAIP2,
  SvmFacilitator,
  SvmPool,
  type PreparedSvmWithdrawal,
} from "../packages/svm/sdk/src/index.js";
import { buildMerkleTree, feToBE32, type AccountSecrets } from "@zbase-protocol/core";

const ACK = "I_ACKNOWLEDGE_DEVNET_WRITES";
if (process.env.ZX402_ALLOW_DEVNET_WRITES !== ACK) {
  throw new Error(
    `This test creates and spends devnet accounts. Set ZX402_ALLOW_DEVNET_WRITES=${ACK} to continue.`,
  );
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey("7qGhxY9Dc9reSNbNHdX1Rtf7hq7D45zdnV1UY3rpt3eM");
const REVIEWED_PROGRAMDATA_SHA256 =
  "a80555ef2de05c8c9639a1cdc0f92306f7730c448805a3a51c05532adfdfa95f";
const PAYMENT_AMOUNT = "5000";

function readOperator(): Keypair {
  const keypairPath =
    process.env.ZX402_RELAYER_KEYPAIR_PATH ||
    path.join(os.homedir(), ".config/solana/id.json");
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf8"))),
  );
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}: ${JSON.stringify(result)}`);
  }
  return result;
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const operator = readOperator();
  const buyer = Keypair.generate();
  const merchant = Keypair.generate();
  const circuitsUrl = path.join(ROOT, "public", "circuits");

  const operatorBalance = await connection.getBalance(operator.publicKey);
  if (operatorBalance < 0.25 * LAMPORTS_PER_SOL) {
    throw new Error("relayer/upgrade wallet needs at least 0.25 devnet SOL");
  }

  console.log("[1/8] Funding an isolated buyer and creating test token state");
  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: operator.publicKey,
        toPubkey: buyer.publicKey,
        lamports: 0.12 * LAMPORTS_PER_SOL,
      }),
    ),
    [operator],
  );
  const mint = await createMint(connection, operator, operator.publicKey, null, 6);
  const buyerAta = await createAssociatedTokenAccountIdempotent(
    connection,
    operator,
    mint,
    buyer.publicKey,
  );
  const merchantAta = await createAssociatedTokenAccountIdempotent(
    connection,
    operator,
    mint,
    merchant.publicKey,
  );
  await mintTo(connection, operator, mint, buyerAta, operator, 2_000_000);

  console.log("[2/8] Initializing a fresh pool and depositing from the isolated buyer");
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

  console.log("[3/8] Publishing the test label as the one-member ASP set");
  const provider = new AnchorProvider(connection, new Wallet(buyer), {
    commitment: "confirmed",
  });
  const idl = JSON.parse(
    fs.readFileSync(path.join(ROOT, "packages/svm/sdk/src/idl.json"), "utf8"),
  );
  const program = new Program(idl, provider);
  const [poolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), mint.toBuffer()],
    PROGRAM_ID,
  );
  const aspTree = buildMerkleTree([BigInt(deposit.secrets.label)]);
  await program.methods
    .updateAspRoot(Array.from(feToBE32(aspTree.root)), "test:single-label")
    .accounts({ poolState: poolPda, postman: buyer.publicKey })
    .rpc();

  console.log("[4/8] Starting the real HTTP facilitator with live ProgramData attestation");
  process.env.ZX402_SVM_READY = "true";
  process.env.ZX402_DEPLOYED_BINARY_SHA256 = REVIEWED_PROGRAMDATA_SHA256;
  process.env.ZX402_RELAYER_SECRET_KEY = JSON.stringify(Array.from(operator.secretKey));
  process.env.ZX402_TOKEN_MINT = mint.toBase58();
  process.env.ZX402_MIN_SETTLEMENT_AMOUNT = PAYMENT_AMOUNT;
  process.env.ZX402_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "zbase-svm-e2e-"));
  process.env.SOLANA_RPC_URL = RPC_URL;

  const facilitator = new SvmFacilitator({
    connection,
    wallet: operator,
    network: "devnet",
    usdcMint: mint,
    circuitsUrl,
    minimumSettlementAmount: PAYMENT_AMOUNT,
    createRecipientTokenAccount: false,
  });
  const require = createRequire(import.meta.url);
  const serverModule = require("../packages/svm/x402-server/index.js") as {
    startServer(port: number, host: string): import("node:http").Server;
    setPrivateFacilitatorForTesting(value: SvmFacilitator): void;
  };
  serverModule.setPrivateFacilitatorForTesting(facilitator);
  const listener = serverModule.startServer(0, "127.0.0.1");
  await new Promise<void>((resolve) => listener.once("listening", resolve));
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("facilitator did not bind TCP");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const supported = await fetch(`${baseUrl}/supported`).then((response) => response.json());
    if (!supported.ready || supported.kinds?.[0]?.scheme !== PRIVATE_SVM_SCHEME) {
      throw new Error(`facilitator did not attest the reviewed program: ${JSON.stringify(supported)}`);
    }

    let spendableNote: AccountSecrets = deposit.secrets;
    let pending: PreparedSvmWithdrawal | undefined;
    const clientScheme = new PrivateExactSvmClientScheme({
      pool: buyerPool,
      getNote: () => spendableNote,
      onPrepared: (prepared) => {
        pending = prepared;
      },
      onSettled: (prepared) => {
        if (!prepared.nextDeposit) throw new Error("expected a change note");
        spendableNote = prepared.nextDeposit;
        pending = undefined;
      },
      onRejected: () => {
        pending = undefined;
      },
      onIndeterminate: () => {
        throw new Error("settlement became indeterminate; reconcile the nullifier manually");
      },
    });

    const requirements: PaymentRequirements = {
      scheme: PRIVATE_SVM_SCHEME,
      network: SOLANA_DEVNET_CAIP2,
      asset: mint.toBase58(),
      amount: PAYMENT_AMOUNT,
      payTo: merchant.publicKey.toBase58(),
      maxTimeoutSeconds: 120,
      extra: {
        relayer: operator.publicKey.toBase58(),
        feePayer: operator.publicKey.toBase58(),
        program: PROGRAM_ID.toBase58(),
        pool: poolPda.toBase58(),
        assetTransferMethod: "zbase-groth16-pool",
        paymentFlow: "authorization",
        proofGeneration: "client",
      },
    };

    const preparePayload = async (): Promise<PaymentPayload> => {
      const created = await clientScheme.createPaymentPayload(2, requirements);
      const paymentPayload = { ...created, accepted: requirements } as PaymentPayload;
      const wire = JSON.stringify(paymentPayload);
      for (const forbidden of ['"secret"', '"nullifier"', '"nextDeposit"']) {
        if (wire.includes(forbidden)) throw new Error(`${forbidden} leaked to facilitator payload`);
      }
      return paymentPayload;
    };

    const settleOnce = async () => {
      const paymentPayload = await preparePayload();
      const envelope = {
        x402Version: 2,
        paymentPayload,
        paymentRequirements: requirements,
      };
      const verified = await postJson<{ isValid: boolean }>(`${baseUrl}/verify`, envelope);
      if (!verified.isValid) throw new Error("facilitator rejected a locally generated proof");
      const settled = await postJson<SettleResponse>(`${baseUrl}/settle`, envelope);
      if (!settled.success) throw new Error(`settlement failed: ${JSON.stringify(settled)}`);
      if (!pending) throw new Error("client lost its pending note before settlement callback");
      await clientScheme.schemeHooks.onPaymentResponse({
        paymentPayload,
        requirements,
        settleResponse: settled,
      });
      return settled.transaction;
    };

    console.log("[5/8] Preparing client-side proof and settling private payment #1");
    const firstSignature = await settleOnce();
    console.log("[6/8] Interleaving a deposit, rebuilding history, and spending change note #1");
    await buyerPool.deposit("1.0");
    const secondSignature = await settleOnce();

    console.log("[7/8] Racing duplicate settlement calls for one proof");
    const racingPayload = await preparePayload();
    const racingEnvelope = {
      x402Version: 2,
      paymentPayload: racingPayload,
      paymentRequirements: requirements,
    };
    const race = await Promise.all([
      postJson<SettleResponse>(`${baseUrl}/settle`, racingEnvelope),
      postJson<SettleResponse>(`${baseUrl}/settle`, racingEnvelope),
    ]);
    const successes = race.filter((result) => result.success);
    const inFlight = race.filter(
      (result) => !result.success && result.errorReason === "private_svm_settlement_in_flight",
    );
    if (successes.length !== 1 || inFlight.length !== 1) {
      throw new Error(`duplicate-settlement race did not serialize: ${JSON.stringify(race)}`);
    }
    await clientScheme.schemeHooks.onPaymentResponse({
      paymentPayload: racingPayload,
      requirements,
      settleResponse: successes[0],
    });

    console.log("[8/8] Checking balances and signer unlinkability");
    const merchantBalance = await getAccount(connection, merchantAta);
    if (merchantBalance.amount !== 15_000n) {
      throw new Error(`merchant received ${merchantBalance.amount}, expected 15000`);
    }
    const settlement = await connection.getTransaction(successes[0].transaction, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    const accountKeys = settlement?.transaction.message.getAccountKeys().staticAccountKeys ?? [];
    if (accountKeys.some((key) => key.equals(buyer.publicKey))) {
      throw new Error("buyer wallet appeared in the private settlement transaction");
    }

    console.log("\nPRIVATE SVM X402 DEVNET E2E PASSED");
    console.log(`pool: ${poolPda.toBase58()}`);
    console.log(`deposit: ${deposit.txHash}`);
    console.log(`settlement #1: ${firstSignature}`);
    console.log(`settlement #2: ${secondSignature}`);
    console.log(`settlement race winner: ${successes[0].transaction}`);
    console.log(`merchant balance: ${merchantBalance.amount} atomic units`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

main().catch((error) => {
  console.error("PRIVATE SVM X402 DEVNET E2E FAILED");
  console.error(error);
  process.exitCode = 1;
});
