const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { Keypair } = require("@solana/web3.js");
const { HTTPFacilitatorClient } = require("@x402/core/server");

const relayer = Keypair.generate();
const recipient = Keypair.generate().publicKey.toBase58();
const poolAddress = Keypair.generate().publicKey.toBase58();
const tokenMint = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const programId = "7qGhxY9Dc9reSNbNHdX1Rtf7hq7D45zdnV1UY3rpt3eM";
const network = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "zbase-svm-server-test-"));

process.env.ZX402_RELAYER_SECRET_KEY = JSON.stringify(Array.from(relayer.secretKey));
process.env.ZX402_SVM_READY = "true";
process.env.ZX402_DEPLOYED_BINARY_SHA256 =
  "a80555ef2de05c8c9639a1cdc0f92306f7730c448805a3a51c05532adfdfa95f";
process.env.ZX402_LOG_DIR = logDir;

const {
  app,
  setPrivateFacilitatorForTesting,
  setProgramAttestationForTesting,
} = require("./index.js");

setProgramAttestationForTesting(async () => ({
  programDataAddress: Keypair.generate().publicKey.toBase58(),
  programDataLength: 532200,
  sha256: "a80555ef2de05c8c9639a1cdc0f92306f7730c448805a3a51c05532adfdfa95f",
}));

test("standard x402 facilitator HTTP surface supports private-exact", async (t) => {
  const { SvmFacilitator } = await import("@zbase-protocol/svm");
  let verifyCalls = 0;
  let relayCalls = 0;
  const fakePool = {
    networkId: network,
    relayerAddress: relayer.publicKey.toBase58(),
    tokenMintAddress: tokenMint,
    programAddress: programId,
    poolAddress,
    async verifyPreparedWithdrawal() {
      verifyCalls += 1;
      return { isValid: true };
    },
    async relayPreparedWithdrawal() {
      relayCalls += 1;
      return "devnet-private-signature";
    },
  };
  setPrivateFacilitatorForTesting(
    new SvmFacilitator({
      pool: fakePool,
      minimumSettlementAmount: "5000",
    }),
  );

  const listener = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => listener.once("listening", resolve));
  t.after(() => new Promise((resolve, reject) => {
    listener.close((error) => error ? reject(error) : resolve());
  }));
  const address = listener.address();
  assert.equal(typeof address, "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const httpFacilitator = new HTTPFacilitatorClient({ url: baseUrl });

  const health = await fetch(`${baseUrl}/health`).then((response) => response.json());
  assert.equal(health.ready, true);
  assert.equal(health.customerReady, false);
  assert.equal(health.programAttestation.programDataLength, 532200);

  const supported = await httpFacilitator.getSupported();
  assert.equal(supported.kinds.length, 1);
  assert.equal(supported.kinds[0].scheme, "private-exact");
  assert.equal(supported.kinds[0].network, network);
  assert.equal(supported.kinds[0].extra.minimumSettlementAmount, "5000");
  assert.equal(supported.kinds[0].extra.recipientTokenAccountCreation, "merchant");

  const requirements = {
    scheme: "private-exact",
    network,
    asset: tokenMint,
    amount: "5000",
    payTo: recipient,
    maxTimeoutSeconds: 60,
    extra: {
      relayer: relayer.publicKey.toBase58(),
      feePayer: relayer.publicKey.toBase58(),
      program: programId,
      pool: poolAddress,
      assetTransferMethod: "zbase-groth16-pool",
      paymentFlow: "authorization",
      proofGeneration: "client",
    },
  };
  const paymentPayload = {
    x402Version: 2,
    accepted: requirements,
    payload: {
      payment: {
        nullifierHash: `0x${"07".repeat(32)}`,
      },
    },
  };
  const envelope = { x402Version: 2, paymentPayload, paymentRequirements: requirements };

  assert.deepEqual(await httpFacilitator.verify(paymentPayload, requirements), {
    isValid: true,
    payer: poolAddress,
  });
  assert.equal(verifyCalls, 1);

  const settled = await httpFacilitator.settle(paymentPayload, requirements);
  assert.equal(settled.success, true);
  assert.equal(settled.transaction, "devnet-private-signature");
  assert.equal(settled.payer, poolAddress);
  assert.equal(verifyCalls, 2);
  assert.equal(relayCalls, 1);

  const aliasVerify = await fetch(`${baseUrl}/api/facilitator/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(envelope),
  });
  assert.equal(aliasVerify.status, 200);
  assert.equal((await aliasVerify.json()).isValid, true);
  assert.equal(verifyCalls, 3);

  const malformedResponse = await fetch(`${baseUrl}/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ x402Version: 1 }),
  });
  assert.equal(malformedResponse.status, 400);
  assert.equal((await malformedResponse.json()).invalidReason, "invalid_request");

  setProgramAttestationForTesting(async () => ({
    programDataAddress: Keypair.generate().publicKey.toBase58(),
    programDataLength: 532200,
    sha256: "0".repeat(64),
  }));
  const staleSupported = await fetch(`${baseUrl}/supported`).then((response) =>
    response.json(),
  );
  assert.equal(staleSupported.ready, false);
  assert.deepEqual(staleSupported.kinds, []);
  assert.match(staleSupported.blockingReasons[0], /does not match the reviewed build/);

  const blockedVerify = await fetch(`${baseUrl}/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(envelope),
  });
  assert.equal(blockedVerify.status, 503);
  assert.equal((await blockedVerify.json()).error, "SVM_NOT_READY");
});
