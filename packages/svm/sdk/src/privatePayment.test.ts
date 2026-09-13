import assert from "node:assert/strict";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { SvmFacilitator } from "./facilitator.js";
import {
  PRIVATE_SVM_SCHEME,
  SOLANA_DEVNET_CAIP2,
  SvmPool,
  deriveSvmRecipientTokenAccount,
  type PreparedSvmWithdrawal,
  type PreparedSvmPayment,
  validatePreparedSvmPayment,
} from "./pool.js";
import {
  PrivateExactSvmClientScheme,
  PrivateExactSvmServerScheme,
} from "./x402.js";

function hex(bytes: Uint8Array): string {
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

function field(value: bigint): string {
  const out = new Uint8Array(32);
  let n = value;
  for (let index = 31; index >= 0; index -= 1) {
    out[index] = Number(n & 0xffn);
    n >>= 8n;
  }
  return hex(out);
}

const programId = "7qGhxY9Dc9reSNbNHdX1Rtf7hq7D45zdnV1UY3rpt3eM";
const pool = Keypair.generate().publicKey.toBase58();
const mint = Keypair.generate().publicKey.toBase58();
const recipient = Keypair.generate().publicKey;
const relayer = Keypair.generate().publicKey;
const amount = "5000";
const nullifierHash = new Uint8Array(32).fill(7);
const withdrawalData = new Uint8Array(72);
withdrawalData.set(recipient.toBytes(), 0);
withdrawalData.set(relayer.toBytes(), 40);

const clientWallet = Keypair.generate();

const nativeReceiverProgram = Keypair.generate().publicKey;
const [programRecipient] = PublicKey.findProgramAddressSync(
  [Buffer.from("native-recipient")],
  nativeReceiverProgram,
);
const expectedProgramAta = PublicKey.findProgramAddressSync(
  [programRecipient.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), new PublicKey(mint).toBuffer()],
  ASSOCIATED_TOKEN_PROGRAM_ID,
)[0];
assert.equal(
  deriveSvmRecipientTokenAccount(new PublicKey(mint), programRecipient).toBase58(),
  expectedProgramAta.toBase58(),
  "PDA recipients must use the canonical off-curve ATA",
);
assert.throws(
  () => getAssociatedTokenAddressSync(new PublicKey(mint), programRecipient),
  /curve/i,
  "the default SPL helper must demonstrate why native-program recipients need explicit support",
);
const clientPoolWithExternalRelayer = new SvmPool({
  connection: new Connection("http://127.0.0.1:8899"),
  wallet: clientWallet,
  relayer,
  network: "devnet",
  usdcMint: new PublicKey(mint),
});
assert.equal(clientPoolWithExternalRelayer.relayerAddress, relayer.toBase58());
assert.notEqual(
  clientPoolWithExternalRelayer.relayerAddress,
  clientWallet.publicKey.toBase58(),
  "a client must bind proofs to the facilitator without holding its signing key",
);

function validPayment(): PreparedSvmPayment {
  return {
    version: 1,
    scheme: PRIVATE_SVM_SCHEME,
    network: SOLANA_DEVNET_CAIP2,
    programId,
    pool,
    tokenMint: mint,
    recipient: recipient.toBase58(),
    relayer: relayer.toBase58(),
    amount,
    relayFeeBps: "0",
    withdrawalData: hex(withdrawalData),
    nullifierHash: hex(nullifierHash),
    proofA: hex(new Uint8Array(64).fill(1)),
    proofB: hex(new Uint8Array(128).fill(2)),
    proofC: hex(new Uint8Array(64).fill(3)),
    publicInputs: [
      field(9n),
      hex(nullifierHash),
      field(BigInt(amount)),
      field(10n),
      field(1n),
      field(11n),
      field(0n),
      field(12n),
    ],
  };
}

const expectations = {
  network: SOLANA_DEVNET_CAIP2,
  programId,
  pool,
  tokenMint: mint,
  relayer: relayer.toBase58(),
  recipient: recipient.toBase58(),
  amount,
  maxRelayFeeBps: 0n,
};

const validated = validatePreparedSvmPayment(validPayment(), expectations);
assert.equal(validated.amount, 5000n);
assert.equal(validated.recipient.toBase58(), recipient.toBase58());

for (const [name, mutate, message] of [
  ["recipient", (p: PreparedSvmPayment) => (p.recipient = Keypair.generate().publicKey.toBase58()), /recipient mismatch/],
  ["amount", (p: PreparedSvmPayment) => (p.amount = "5001"), /amount mismatch/],
  ["relayer", (p: PreparedSvmPayment) => (p.relayer = Keypair.generate().publicKey.toBase58()), /relayer mismatch/],
  ["withdrawal bytes", (p: PreparedSvmPayment) => (p.withdrawalData = hex(new Uint8Array(72))), /canonical/],
  ["nullifier binding", (p: PreparedSvmPayment) => (p.publicInputs[1] = field(99n)), /nullifierHash/],
  ["amount binding", (p: PreparedSvmPayment) => (p.publicInputs[2] = field(4999n)), /does not match amount/],
] as const) {
  const payment = validPayment();
  mutate(payment);
  assert.throws(
    () => validatePreparedSvmPayment(payment, expectations),
    message,
    `${name} mutation must fail closed`,
  );
}

const leaked = { ...validPayment(), secret: "do-not-send" } as PreparedSvmPayment;
assert.throws(
  () => validatePreparedSvmPayment(leaked, expectations),
  /must never be sent/,
);
const aliasedLeak = {
  ...validPayment(),
  existingSecret: "also-do-not-send",
} as PreparedSvmPayment;
assert.throws(
  () => validatePreparedSvmPayment(aliasedLeak, expectations),
  /unexpected private SVM payment field/,
);

let relayed = 0;
const fakePool = {
  networkId: SOLANA_DEVNET_CAIP2,
  relayerAddress: relayer.toBase58(),
  tokenMintAddress: mint,
  programAddress: programId,
  poolAddress: pool,
  async verifyPreparedWithdrawal(
    payment: PreparedSvmPayment,
    expected?: { recipient?: string; amount?: string },
  ) {
    validatePreparedSvmPayment(payment, { ...expectations, ...expected });
    return { isValid: true };
  },
  async relayPreparedWithdrawal(
    payment: PreparedSvmPayment,
    expected?: { recipient?: string; amount?: string },
  ) {
    validatePreparedSvmPayment(payment, { ...expectations, ...expected });
    relayed += 1;
    return "devnet-signature";
  },
};
const facilitator = new SvmFacilitator({
  connection: null as never,
  wallet: Keypair.generate(),
  pool: fakePool,
});
const supported = facilitator.getSupported();
assert.deepEqual(supported.signers["solana:*"], [relayer.toBase58()]);
assert.equal(supported.kinds[0].scheme, PRIVATE_SVM_SCHEME);
assert.equal(supported.kinds[0].extra?.minimumSettlementAmount, "1");
assert.equal(supported.kinds[0].extra?.recipientTokenAccountCreation, "merchant");
const requirements = {
  scheme: PRIVATE_SVM_SCHEME,
  network: SOLANA_DEVNET_CAIP2,
  asset: mint,
  amount,
  payTo: recipient.toBase58(),
  maxTimeoutSeconds: 60,
  extra: {
    relayer: relayer.toBase58(),
    feePayer: relayer.toBase58(),
    program: programId,
    pool,
    assetTransferMethod: "zbase-groth16-pool",
    paymentFlow: "authorization",
    proofGeneration: "client",
  },
} as PaymentRequirements;
const payload = {
  x402Version: 2,
  accepted: requirements,
  payload: { payment: validPayment() },
} as PaymentPayload;

assert.equal((await facilitator.verify(payload, requirements)).isValid, true);
const settled = await facilitator.settle(payload, requirements);
assert.equal(settled.success, true);
assert.equal(settled.transaction, "devnet-signature");
assert.equal(relayed, 1);

const confusedRequirements = { ...requirements, amount: "5001" };
assert.equal((await facilitator.verify(payload, confusedRequirements)).isValid, false);
const confusedRecipient = {
  ...requirements,
  payTo: Keypair.generate().publicKey.toBase58(),
};
assert.equal((await facilitator.verify(payload, confusedRecipient)).isValid, false);
const confusedProgram = {
  ...requirements,
  extra: { ...requirements.extra, program: Keypair.generate().publicKey.toBase58() },
};
assert.equal(
  (await facilitator.verify({ ...payload, accepted: confusedProgram }, confusedProgram)).isValid,
  false,
);

const minimumFacilitator = new SvmFacilitator({
  connection: null as never,
  wallet: Keypair.generate(),
  pool: fakePool,
  minimumSettlementAmount: 5001n,
});
assert.equal(
  (await minimumFacilitator.verify(payload, requirements)).isValid,
  false,
  "facilitator must reject uneconomic payments below its configured minimum",
);

let releaseRelay!: (signature: string) => void;
let markRelayStarted!: () => void;
const relayStarted = new Promise<void>((resolve) => {
  markRelayStarted = resolve;
});
const concurrentPool = {
  ...fakePool,
  async relayPreparedWithdrawal() {
    markRelayStarted();
    return await new Promise<string>((resolve) => {
      releaseRelay = resolve;
    });
  },
};
const concurrentFacilitator = new SvmFacilitator({
  connection: null as never,
  wallet: Keypair.generate(),
  pool: concurrentPool,
});
const firstSettlement = concurrentFacilitator.settle(payload, requirements);
await relayStarted;
const racingSettlement = await concurrentFacilitator.settle(payload, requirements);
assert.equal(racingSettlement.success, false);
if (!racingSettlement.success) {
  assert.equal(racingSettlement.errorReason, "private_svm_settlement_in_flight");
}
releaseRelay("serialized-devnet-signature");
assert.equal((await firstSettlement).success, true);

const serverScheme = new PrivateExactSvmServerScheme();
assert.equal(serverScheme.defaultAssetTransferMethod, "zbase-groth16-pool");
assert.deepEqual(serverScheme.paymentFlows["zbase-groth16-pool"].supported, [
  "authorization",
]);
const enhanced = await serverScheme.enhancePaymentRequirements(
  requirements,
  {
    x402Version: 2,
    scheme: PRIVATE_SVM_SCHEME,
    network: SOLANA_DEVNET_CAIP2,
    extra: { feePayer: relayer.toBase58(), relayer: relayer.toBase58() },
  },
  [],
);
assert.equal(enhanced.scheme, PRIVATE_SVM_SCHEME);
assert.equal(enhanced.extra.assetTransferMethod, "zbase-groth16-pool");
assert.equal(enhanced.extra.paymentFlow, "authorization");
assert.equal(enhanced.extra.proofGeneration, "client");

const prepared: PreparedSvmWithdrawal = {
  payment: validPayment(),
  remainingValue: "1000",
  nextDeposit: {
    nullifier: "101",
    secret: "202",
    commitment: "303",
    label: "404",
    value: "1000",
  },
  proofTimeMs: 10,
};
const clientPool = {
  networkId: SOLANA_DEVNET_CAIP2,
  tokenMintAddress: mint,
  programAddress: programId,
  poolAddress: pool,
  relayerAddress: relayer.toBase58(),
  async prepareWithdrawal() {
    return prepared;
  },
  async isPreparedWithdrawalSpent() {
    return reconciledSpent;
  },
} as unknown as SvmPool;
let preparedCount = 0;
let settledCount = 0;
let rejectedCount = 0;
let indeterminateCount = 0;
let reconciledCount = 0;
let reconciledSpent = false;
const clientScheme = new PrivateExactSvmClientScheme({
  pool: clientPool,
  getNote: () => ({
    nullifier: "1",
    secret: "2",
    commitment: "3",
    label: "4",
    value: "6000",
  }),
  onPrepared: () => {
    preparedCount += 1;
  },
  onSettled: () => {
    settledCount += 1;
  },
  onRejected: () => {
    rejectedCount += 1;
  },
  onIndeterminate: () => {
    indeterminateCount += 1;
  },
  onReconciled: (_prepared, result) => {
    assert.equal(result.spent, true);
    reconciledCount += 1;
  },
});
const clientPayload = await clientScheme.createPaymentPayload(2, requirements);
assert.equal(preparedCount, 1);
assert.equal(JSON.stringify(clientPayload).includes('"secret"'), false);
await clientScheme.schemeHooks.onPaymentResponse({
  paymentPayload: { ...clientPayload, accepted: requirements },
  requirements,
  settleResponse: {
    success: true,
    payer: pool,
    transaction: "devnet-signature",
    network: SOLANA_DEVNET_CAIP2,
  },
});
assert.equal(settledCount, 1);
assert.equal(rejectedCount, 0);
assert.equal(indeterminateCount, 0);

const rejectedPayload = await clientScheme.createPaymentPayload(2, requirements);
await clientScheme.schemeHooks.onPaymentResponse({
  paymentPayload: { ...rejectedPayload, accepted: requirements },
  requirements,
  paymentRequired: {} as never,
});
assert.equal(rejectedCount, 1, "definitive verify rejection may unlock the old note");

const ambiguousPayload = await clientScheme.createPaymentPayload(2, requirements);
await clientScheme.schemeHooks.onPaymentResponse({
  paymentPayload: { ...ambiguousPayload, accepted: requirements },
  requirements,
  settleResponse: {
    success: false,
    errorReason: "confirmation_timeout",
    transaction: "",
    network: SOLANA_DEVNET_CAIP2,
  },
});
assert.equal(indeterminateCount, 1, "failed settle must keep both notes locked");
assert.equal(rejectedCount, 1);

await clientScheme.schemeHooks.onPaymentResponse({
  paymentPayload: { ...ambiguousPayload, accepted: requirements },
  requirements,
  paymentRequired: {} as never,
});
assert.equal(
  rejectedCount,
  1,
  "an indeterminate payment must never be downgraded to a rejection",
);
assert.equal(indeterminateCount, 2);
await assert.rejects(
  clientScheme.createPaymentPayload(2, requirements),
  /already pending or indeterminate/,
  "an unresolved note must not produce a second payment",
);
await assert.rejects(
  clientScheme.reconcilePayment(prepared.payment.nullifierHash),
  /absence does not prove the relay transaction expired/,
);
await assert.rejects(
  clientScheme.createPaymentPayload(2, requirements),
  /already pending or indeterminate/,
  "a missing finalized nullifier must leave the note locked",
);
reconciledSpent = true;
const reconciled = await clientScheme.reconcilePayment(prepared.payment.nullifierHash);
assert.equal(reconciled.spent, true);
assert.equal(reconciledCount, 1);

// The proof-bearing payload must not include the original or change-note
// secrets anywhere in its JSON representation.
const serialized = JSON.stringify(payload);
for (const forbidden of ['"secret"', '"nullifier"', '"nextDeposit"']) {
  assert.equal(serialized.includes(forbidden), false, `${forbidden} leaked into x402 payload`);
}

console.log("private SVM x402 payment binding tests passed");
