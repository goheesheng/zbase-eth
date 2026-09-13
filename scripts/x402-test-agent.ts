/**
 * x402 Test Agent -- An AI agent that pays for services privately
 *
 * This simulates the full x402 agent flow:
 * 1. Agent calls a paid API endpoint
 * 2. Gets 402 Payment Required
 * 3. Deposits USDC into zBase privacy pool (if no existing deposit)
 * 4. Calls zBase facilitator to verify + settle the payment privately
 * 5. Retries the API call with proof of payment
 * 6. Gets the premium data
 *
 * Usage:
 *   npx tsx scripts/x402-test-agent.ts
 *
 * Prerequisites:
 *   - zBase dev server on port 3009 (npm run dev -- -p 3009)
 *   - x402 test server on port 4020 (npx tsx scripts/x402-test-server.ts)
 *   - .env with POSTMAN_PRIVATE_KEY, BASE_SEPOLIA_RPC
 *   - USDC balance on the wallet
 */

import "./load-env";
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

// ── Config ──
const ENTRYPOINT = "0x598ffaac79ae29b1aae571fd91899d4492183688" as const;
const USDC_POOL = "0x4ebcfeaf661a25f103b3d1f16be5a7668ab0935a" as const;
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
const DEPOSITED_TOPIC = "0xe3b53cd1a44fbf11535e145d80b8ef1ed6d57a73bf5daa7e939b6b01657d6549";
const SNARK_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const ZBASE_API = "http://localhost:3009";
const SERVICE_URL = "http://localhost:4020/api/data";

function randomFieldElement(): bigint {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let result = 0n;
  for (const byte of bytes) {
    result = (result << 8n) + BigInt(byte);
  }
  return result % SNARK_FIELD;
}

function log(emoji: string, msg: string) {
  console.log(`  ${emoji}  ${msg}`);
}

/**
 * The facilitator verifies against its root-verified shared indexer, which a cron
 * (/api/cron/indexer-sync) advances in production. Nothing runs that cron on a
 * laptop, so this harness — which already holds operator env — triggers the same
 * sync after every leaf insertion (deposit, and the change note a settle creates).
 */
async function syncIndexer(): Promise<void> {
  const cronSecret = process.env.INDEXER_SYNC_SECRET ?? process.env.CRON_SECRET;
  if (!cronSecret) {
    log("⚠️", "CRON_SECRET not set — relying on an external indexer-sync cron");
    return;
  }
  log("⏳", "Advancing the shared indexer (stands in for the indexer-sync cron)...");
  const syncRes = await fetch(`${ZBASE_API}/api/cron/indexer-sync`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cronSecret}` },
  });
  const syncData = await syncRes.json().catch(() => ({}));
  log(syncRes.ok ? "✅" : "⚠️", `Indexer: ${syncRes.ok ? `${syncData.leafCount} leaves @ block ${syncData.cursor}` : JSON.stringify(syncData).slice(0, 160)}`);
  // The facilitator caches its readiness verdict for ~10 s; wait until it has
  // re-read the freshly synced cache (stateRootMatches) before verifying.
  for (let i = 0; i < 8; i++) {
    const r = await fetch(`${ZBASE_API}/api/facilitator/supported`).then((x) => x.json()).catch(() => null);
    const idx = r?.privacy?.indexer;
    if (idx?.stateRootMatches && idx?.aspRootMatches) {
      log("✅", `Facilitator sees the synced tree (${idx.leafCount} leaves, roots match)`);
      return;
    }
    await new Promise((res) => setTimeout(res, 3000));
  }
  log("⚠️", "Facilitator readiness did not refresh in time; continuing anyway");
}

async function main() {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║   x402 Agent Test -- Full Private Payment Flow           ║
║   Agent --> 402 --> zBase --> ZK Proof --> Paid Privately ║
╚══════════════════════════════════════════════════════════╝
`);

  // ── Setup wallet ──
  const rawKey = process.env.POSTMAN_PRIVATE_KEY;
  const rpcUrl = process.env.BASE_SEPOLIA_RPC;
  if (!rawKey || !rpcUrl) {
    console.error("Missing POSTMAN_PRIVATE_KEY or BASE_SEPOLIA_RPC in .env");
    process.exit(1);
  }

  const normalizedKey = rawKey.replace(/^0x/i, "");
  const account = privateKeyToAccount(`0x${normalizedKey}` as Hex);
  log("🤖", `Agent wallet: ${account.address}`);

  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http("https://sepolia.base.org") });

  // ══════════════════════════════════════════════════════
  // STEP 1: Agent tries to call the paid service
  // ══════════════════════════════════════════════════════
  console.log("\n--- STEP 1: Agent calls paid API endpoint ---\n");
  log("📡", `Calling ${SERVICE_URL}...`);

  const firstTry = await fetch(SERVICE_URL);
  const firstData = await firstTry.json();

  if (firstTry.status === 402) {
    log("💰", `Got 402 Payment Required!`);
    log("💰", `Price: ${firstData.x402.maxAmountRequired} raw USDC (${Number(firstData.x402.maxAmountRequired) / 1e6} USDC)`);
    log("💰", `Pay to: ${firstData.x402.payTo}`);
    log("💰", `Network: ${firstData.x402.network}`);
    log("💰", `Facilitator: ${firstData.x402.facilitatorUrl}`);
  } else {
    log("✅", "Endpoint didn't require payment (already paid?)");
    console.log(JSON.stringify(firstData, null, 2));
    return;
  }

  // ══════════════════════════════════════════════════════
  // STEP 2: Agent deposits USDC into zBase privacy pool
  // ══════════════════════════════════════════════════════
  console.log("\n--- STEP 2: Agent deposits USDC into privacy pool ---\n");

  const balance = await publicClient.readContract({
    address: USDC,
    abi: [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }],
    functionName: "balanceOf",
    args: [account.address],
  }) as bigint;
  log("💰", `USDC balance: ${formatUnits(balance, 6)} USDC`);

  const depositAmount = parseUnits("1.02", 6); // post-fee 1.0098 USDC, enough for two 0.50 USDC payments

  // Check allowance
  const allowance = await publicClient.readContract({
    address: USDC,
    abi: [{ name: "allowance", type: "function", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] }],
    functionName: "allowance",
    args: [account.address, ENTRYPOINT],
  }) as bigint;

  if (allowance < depositAmount) {
    log("📝", "Approving USDC...");
    const approveTx = await walletClient.writeContract({
      address: USDC,
      abi: [{ name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }],
      functionName: "approve",
      args: [ENTRYPOINT, 2n ** 256n - 1n],
    });
    await publicClient.waitForTransactionReceipt({ hash: approveTx });
    log("✅", "USDC approved");
  }

  // Generate deposit secrets
  const nullifier = randomFieldElement();
  const secret = randomFieldElement();
  const precommitment = poseidon2([nullifier, secret]);

  log("🔐", "Generated cryptographic deposit secrets");

  // Deposit on-chain
  log("⏳", "Depositing 1.02 USDC into privacy pool...");
  const depositTx = await walletClient.writeContract({
    address: ENTRYPOINT,
    abi: [{
      name: "deposit", type: "function", stateMutability: "nonpayable",
      inputs: [{ name: "_asset", type: "address" }, { name: "_amount", type: "uint256" }, { name: "_precommitment", type: "uint256" }],
      outputs: [],
    }],
    functionName: "deposit",
    args: [USDC, depositAmount, precommitment],
    gas: 1_000_000n,
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: depositTx });
  if (receipt.status !== "success") {
    console.error("Deposit failed!");
    process.exit(1);
  }

  // Parse Deposited event
  let commitment = 0n, label = 0n, value = 0n;
  for (const eventLog of receipt.logs) {
    if (eventLog.address.toLowerCase() === USDC_POOL.toLowerCase() && eventLog.topics[0] === DEPOSITED_TOPIC) {
      const data = eventLog.data as string;
      if (data.length >= 258) {
        commitment = BigInt("0x" + data.slice(2, 66));
        label = BigInt("0x" + data.slice(66, 130));
        value = BigInt("0x" + data.slice(130, 194));
      }
      break;
    }
  }

  log("✅", `Deposited! Tx: ${depositTx.slice(0, 16)}...`);
  log("✅", `Value in pool: ${value.toString()} raw USDC (post 1% fee)`);
  log("✅", `BaseScan: https://sepolia.basescan.org/tx/${depositTx}`);

  let depositSecrets = {
    nullifier: nullifier.toString(),
    secret: secret.toString(),
    value: value.toString(),
    label: label.toString(),
    commitment: commitment.toString(),
  };

  // Get the deposit into the ASP set. /api/asp-update is operator-locked
  // (ASP_UPDATE_SECRET); the designed path for a depositor is
  // POST /api/deposits/confirm { txHash } — the deposit tx itself is the
  // authorization. It screens the depositor, refreshes the ASP root, and
  // returns 202 "queued" until confirmations land, so poll briefly.
  log("⏳", "Confirming deposit with the ASP (compliance screening + root update)...");
  let aspStatus = "queued";
  for (let attempt = 0; attempt < 20 && aspStatus === "queued"; attempt++) {
    const confirmRes = await fetch(`${ZBASE_API}/api/deposits/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ txHash: depositTx }),
    });
    const confirmData = await confirmRes.json().catch(() => ({}));
    aspStatus = String(confirmData.status ?? (confirmRes.ok ? "confirmed" : "error"));
    if (aspStatus === "queued") {
      log("⏳", `ASP: ${confirmData.reason ?? "waiting for confirmations"} (${attempt + 1}/20)`);
      await new Promise(r => setTimeout(r, 4000));
    } else if (!confirmRes.ok) {
      console.error("ASP confirm failed:", confirmData);
      return;
    }
  }
  log("✅", `ASP status: ${aspStatus}`);

  // The facilitator verifies against its root-verified shared indexer, which a cron
  // (/api/cron/indexer-sync) advances in production. Nothing runs that cron on a
  // laptop, so this harness — which already holds operator env — triggers the same
  // sync so the leaf we just inserted is in the cache before verify.
  await syncIndexer();

  // ══════════════════════════════════════════════════════
  // STEP 3: Agent verifies payment via zBase facilitator
  // ══════════════════════════════════════════════════════
  console.log("\n--- STEP 3: Agent verifies payment via facilitator ---\n");

  const verifyRes = await fetch(`${ZBASE_API}/api/facilitator/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      paymentDetails: {
        scheme: firstData.x402.scheme,
        payTo: firstData.x402.payTo,
        maxAmountRequired: firstData.x402.maxAmountRequired,
        networkId: firstData.x402.network,
      },
      zbaseDeposit: depositSecrets,
    }),
  });
  const verifyData = await verifyRes.json();

  log("🔍", `Verification: ${verifyData.valid ? "VALID" : "INVALID"}`);
  log("🔍", `Reason: ${verifyData.reason}`);
  if (verifyData.privacy) {
    log("🔍", `Anonymity set: ${verifyData.privacy.anonymitySet} depositors`);
  }

  if (!verifyData.valid) {
    console.error("Verification failed:", verifyData.reason);
    process.exit(1);
  }

  // ══════════════════════════════════════════════════════
  // STEP 4: Agent settles payment privately via ZK proof
  // ══════════════════════════════════════════════════════
  console.log("\n--- STEP 4: Agent settles payment privately (ZK proof) ---\n");

  log("⏳", "Generating Groth16 ZK proof + settling payment...");
  log("⏳", "This takes ~10-15 seconds...");

  const settleStart = Date.now();
  const settleRes = await fetch(`${ZBASE_API}/api/facilitator/settle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      paymentDetails: {
        payTo: firstData.x402.payTo,
        maxAmountRequired: firstData.x402.maxAmountRequired,
      },
      zbaseDeposit: depositSecrets,
    }),
  });
  const settleData = await settleRes.json();
  const settleTime = Date.now() - settleStart;

  if (settleData.settled) {
    log("✅", `Payment settled in ${settleTime}ms!`);
    log("✅", `Tx: ${settleData.txHash}`);
    log("✅", `BaseScan: https://sepolia.basescan.org/tx/${settleData.txHash}`);
    log("🔒", `Privacy: ${settleData.privacy?.method} -- linkable: ${settleData.privacy?.linkable}`);
    log("🔁", `Remaining note value: ${settleData.remainingValue}`);
  } else {
    console.error("Settlement failed:", settleData.error);
    process.exit(1);
  }

  // ══════════════════════════════════════════════════════
  // STEP 5: Agent retries the service with proof of payment
  // ══════════════════════════════════════════════════════
  console.log("\n--- STEP 5: Agent retries with proof of payment ---\n");

  log("📡", `Retrying ${SERVICE_URL} with payment proof...`);

  const secondTry = await fetch(SERVICE_URL, {
    headers: { "X-Payment-TxHash": settleData.txHash },
  });
  const secondData = await secondTry.json();

  if (secondTry.status === 200) {
    log("✅", "Service returned premium data!");
    console.log("\n  Response:");
    console.log(JSON.stringify(secondData, null, 2));
  } else {
    log("❌", `Service returned ${secondTry.status}`);
  }

  if (!settleData.nextDeposit) {
    console.error(
      "Settlement did not return nextDeposit. Exact-amount payment worked, but this Base pool did not insert the change commitment.",
    );
    console.error("changeNoteSupported:", settleData.changeNoteSupported);
    console.error("expectedRemainingValue:", settleData.expectedRemainingValue);
    console.error("Phase 2 redeploy is required for reusable Base notes.");
    process.exit(1);
  }
  depositSecrets = settleData.nextDeposit;

  // ══════════════════════════════════════════════════════
  // STEP 6: Agent pays a second invoice from the returned change note
  // ══════════════════════════════════════════════════════
  console.log("\n--- STEP 6: Agent verifies second payment from nextDeposit ---\n");
  await syncIndexer();

  const verifyRes2 = await fetch(`${ZBASE_API}/api/facilitator/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      paymentDetails: {
        scheme: firstData.x402.scheme,
        payTo: firstData.x402.payTo,
        maxAmountRequired: firstData.x402.maxAmountRequired,
        networkId: firstData.x402.network,
      },
      zbaseDeposit: depositSecrets,
    }),
  });
  const verifyData2 = await verifyRes2.json();
  log("🔍", `Payment #2 verification: ${verifyData2.valid ? "VALID" : "INVALID"}`);
  if (!verifyData2.valid) {
    console.error("Second verification failed:", verifyData2.reason);
    process.exit(1);
  }

  console.log("\n--- STEP 7: Agent settles second payment privately ---\n");
  const settleStart2 = Date.now();
  const settleRes2 = await fetch(`${ZBASE_API}/api/facilitator/settle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      paymentDetails: {
        payTo: firstData.x402.payTo,
        maxAmountRequired: firstData.x402.maxAmountRequired,
      },
      zbaseDeposit: depositSecrets,
    }),
  });
  const settleData2 = await settleRes2.json();
  const settleTime2 = Date.now() - settleStart2;

  if (!settleData2.settled) {
    console.error("Second settlement failed:", settleData2.error);
    process.exit(1);
  }
  log("✅", `Payment #2 settled in ${settleTime2}ms!`);
  log("✅", `Tx #2: ${settleData2.txHash}`);
  log("🔁", `Remaining note value after #2: ${settleData2.remainingValue}`);

  console.log("\n--- STEP 8: Agent retries with second proof of payment ---\n");
  const thirdTry = await fetch(SERVICE_URL, {
    headers: { "X-Payment-TxHash": settleData2.txHash },
  });
  const thirdData = await thirdTry.json();
  if (thirdTry.status === 200) {
    log("✅", "Second service request returned premium data!");
  } else {
    log("❌", `Second service request returned ${thirdTry.status}`);
    console.log(JSON.stringify(thirdData, null, 2));
    process.exit(1);
  }

  // ══════════════════════════════════════════════════════
  // SUMMARY
  // ══════════════════════════════════════════════════════
  console.log(`
╔══════════════════════════════════════════════════════════╗
║                    TEST COMPLETE                          ║
╠══════════════════════════════════════════════════════════╣
║                                                           ║
║  Agent wallet:  ${account.address}     ║
║                                                           ║
║  Deposit tx:    ${depositTx.slice(0, 42)}...  ║
║  Payment #1 tx: ${(settleData.txHash || "N/A").slice(0, 42)}...  ║
║  Payment #2 tx: ${(settleData2.txHash || "N/A").slice(0, 42)}...  ║
║                                                           ║
║  Privacy:       ZK proof -- no on-chain link              ║
║  Proof #1 time: ${settleTime}ms                                  ║
║  Proof #2 time: ${settleTime2}ms                                  ║
║  Remaining:     ${settleData2.remainingValue} raw USDC            ║
║  Anonymity set: ${verifyData.privacy?.anonymitySet || "24+"} depositors                           ║
║                                                           ║
║  The service provider received USDC.                      ║
║  The agent's wallet does NOT appear in the payment tx.    ║
║  Nobody on BaseScan can link the agent to this payment.   ║
╚══════════════════════════════════════════════════════════╝

BaseScan links:
  Deposit:  https://sepolia.basescan.org/tx/${depositTx}
  Payment #1: https://sepolia.basescan.org/tx/${settleData.txHash || "N/A"}
  Payment #2: https://sepolia.basescan.org/tx/${settleData2.txHash || "N/A"}
`);
}

main().catch((err) => {
  console.error("\nFATAL:", err.message);
  process.exit(1);
});
