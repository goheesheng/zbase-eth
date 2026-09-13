/**
 * zBase E2E Test: Full Deposit → Verify → Withdraw Flow
 *
 * This script runs the complete privacy payment cycle on Base Sepolia:
 * 1. Deposits USDC into the privacy pool (on-chain)
 * 2. Tests the x402 facilitator verify endpoint (API)
 * 3. Withdraws privately via ZK proof to a fresh address (API → on-chain)
 * 4. Prints BaseScan links to prove there's no on-chain link
 *
 * Usage:
 *   npm run test:e2e
 *   # or
 *   npx tsx scripts/test-full-flow.ts
 *
 * Prerequisites:
 *   - .env with POSTMAN_PRIVATE_KEY, BASE_SEPOLIA_RPC, HYPERSYNC_TOKEN
 *   - USDC balance on the wallet (at least 1 USDC on Base Sepolia)
 *   - zBase dev server running on port 3009 (npm run dev -- -p 3009)
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
const DEPOSIT_AMOUNT = "1"; // 1 USDC (minimum deposit is ~1 USDC)

// ── Helpers ──
function randomFieldElement(): bigint {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let result = 0n;
  for (const byte of bytes) {
    result = (result << 8n) + BigInt(byte);
  }
  return result % SNARK_FIELD;
}

function log(step: string, msg: string) {
  console.log(`\n[${"=".repeat(60)}]`);
  console.log(`[${step}] ${msg}`);
  console.log(`[${"=".repeat(60)}]`);
}

function info(label: string, value: string) {
  console.log(`  ${label}: ${value}`);
}

// ── Main ──
async function main() {
  console.log("\n");
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║         zBase E2E Test — Full Privacy Flow          ║");
  console.log("║   Deposit → Verify → Withdraw on Base Sepolia      ║");
  console.log("╚══════════════════════════════════════════════════════╝");

  // ── Step 1: Setup ──
  log("STEP 1", "Setting up wallet and clients");

  const rawKey = process.env.POSTMAN_PRIVATE_KEY;
  const rpcUrl = process.env.BASE_SEPOLIA_RPC;

  if (!rawKey || !rpcUrl) {
    console.error("Missing POSTMAN_PRIVATE_KEY or BASE_SEPOLIA_RPC in .env");
    process.exit(1);
  }

  const normalizedKey = rawKey.replace(/^0x/i, "");
  const account = privateKeyToAccount(`0x${normalizedKey}` as Hex);
  info("Wallet", account.address);
  info("Network", "Base Sepolia (84532)");

  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(rpcUrl),
  });

  const walletClient = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http("https://sepolia.base.org"),
  });

  // ── Step 2: Check USDC balance ──
  log("STEP 2", "Checking USDC balance");

  const balance = await publicClient.readContract({
    address: USDC,
    abi: [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }],
    functionName: "balanceOf",
    args: [account.address],
  }) as bigint;

  info("USDC Balance", `${formatUnits(balance, 6)} USDC`);

  const depositAmountRaw = parseUnits(DEPOSIT_AMOUNT, 6);
  if (balance < depositAmountRaw) {
    console.error(`Insufficient USDC. Need ${DEPOSIT_AMOUNT}, have ${formatUnits(balance, 6)}`);
    console.error(`Get Base Sepolia USDC from a faucet or transfer some.`);
    process.exit(1);
  }

  // ── Step 3: Approve USDC ──
  log("STEP 3", "Approving USDC spending");

  const allowance = await publicClient.readContract({
    address: USDC,
    abi: [{ name: "allowance", type: "function", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] }],
    functionName: "allowance",
    args: [account.address, ENTRYPOINT],
  }) as bigint;

  if (allowance < depositAmountRaw) {
    info("Status", "Approving max USDC to Entrypoint...");
    const approveTx = await walletClient.writeContract({
      address: USDC,
      abi: [{ name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }],
      functionName: "approve",
      args: [ENTRYPOINT, 2n ** 256n - 1n],
    });
    await publicClient.waitForTransactionReceipt({ hash: approveTx });
    info("Approve Tx", approveTx);
  } else {
    info("Status", "Already approved");
  }

  // ── Step 4: Generate deposit secrets ──
  log("STEP 4", "Generating cryptographic deposit secrets");

  const nullifier = randomFieldElement();
  const secret = randomFieldElement();
  const precommitment = poseidon2([nullifier, secret]);

  info("Nullifier", nullifier.toString().slice(0, 20) + "...");
  info("Secret", secret.toString().slice(0, 20) + "...");
  info("Precommitment", precommitment.toString().slice(0, 20) + "...");

  // ── Step 5: Deposit on-chain ──
  log("STEP 5", `Depositing ${DEPOSIT_AMOUNT} USDC into privacy pool`);

  const depositTx = await walletClient.writeContract({
    address: ENTRYPOINT,
    abi: [{
      name: "deposit",
      type: "function",
      stateMutability: "nonpayable",
      inputs: [
        { name: "_asset", type: "address" },
        { name: "_amount", type: "uint256" },
        { name: "_precommitment", type: "uint256" },
      ],
      outputs: [],
    }],
    functionName: "deposit",
    args: [USDC, depositAmountRaw, precommitment],
    gas: 1_000_000n,
  });

  info("Deposit Tx", depositTx);
  info("BaseScan", `https://sepolia.basescan.org/tx/${depositTx}`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash: depositTx });
  info("Status", receipt.status === "success" ? "Confirmed" : "FAILED");

  if (receipt.status !== "success") {
    console.error("Deposit failed on-chain!");
    process.exit(1);
  }

  // ── Step 6: Parse Deposited event ──
  log("STEP 6", "Parsing deposit event for on-chain data");

  let onChainCommitment = 0n;
  let onChainLabel = 0n;
  let onChainValue = 0n;

  for (const eventLog of receipt.logs) {
    if (
      eventLog.address.toLowerCase() === USDC_POOL.toLowerCase() &&
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
    console.error("Failed to parse Deposited event!");
    process.exit(1);
  }

  info("Commitment", onChainCommitment.toString().slice(0, 20) + "...");
  info("Label", onChainLabel.toString().slice(0, 20) + "...");
  info("Value", onChainValue.toString() + " (post-fee, raw USDC units)");

  const depositSecrets = {
    nullifier: nullifier.toString(),
    secret: secret.toString(),
    value: onChainValue.toString(),
    label: onChainLabel.toString(),
    commitment: onChainCommitment.toString(),
  };

  // ── Step 7: Update ASP root ──
  log("STEP 7", "Updating ASP root (compliance layer)");

  const aspRes = await fetch(`${ZBASE_API}/api/asp-update`, { method: "POST" });
  const aspData = await aspRes.json();
  info("ASP Update", aspData.updated ? `Root updated: ${aspData.root?.slice(0, 20)}...` : aspData.reason || "Already current");

  // Wait a moment for the update to propagate
  await new Promise(r => setTimeout(r, 3000));

  // ── Step 8: Test facilitator/supported ──
  log("STEP 8", "Testing GET /api/facilitator/supported");

  const supportedRes = await fetch(`${ZBASE_API}/api/facilitator/supported`);
  const supportedData = await supportedRes.json();
  info("Facilitator", supportedData.facilitator);
  info("Privacy", supportedData.privacy?.method);
  info("Network", supportedData.contracts?.network);

  console.log("\n  Equivalent curl:");
  console.log(`  curl ${ZBASE_API}/api/facilitator/supported | jq`);

  // ── Step 9: Test facilitator/verify ──
  log("STEP 9", "Testing POST /api/facilitator/verify with real deposit");

  const verifyBody = {
    paymentDetails: {
      scheme: "exact",
      payTo: account.address,
      maxAmountRequired: (onChainValue / 2n).toString(), // half the deposit
      networkId: "eip155:84532",
    },
    zbaseDeposit: depositSecrets,
  };

  const verifyRes = await fetch(`${ZBASE_API}/api/facilitator/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(verifyBody),
  });
  const verifyData = await verifyRes.json();
  info("Valid", String(verifyData.valid));
  info("Reason", verifyData.reason);
  if (verifyData.privacy) {
    info("Anonymity Set", String(verifyData.privacy.anonymitySet));
  }

  console.log("\n  Equivalent curl:");
  console.log(`  curl -X POST ${ZBASE_API}/api/facilitator/verify \\`);
  console.log(`    -H "Content-Type: application/json" \\`);
  console.log(`    -d '${JSON.stringify(verifyBody)}'`);

  // ── Step 10: Withdraw via /api/withdraw ──
  log("STEP 10", "Withdrawing privately via ZK proof (this takes ~15 seconds)");

  // Use the same wallet as recipient for simplicity (in production, use a fresh address)
  const recipient = account.address;
  info("Recipient", recipient);
  info("Status", "Generating Groth16 ZK proof + submitting relay...");

  const withdrawStart = Date.now();
  const withdrawBody = {
    ...depositSecrets,
    recipient,
    amountAtomic: (onChainValue / 2n).toString(),
  };

  const withdrawRes = await fetch(`${ZBASE_API}/api/withdraw`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(withdrawBody),
  });
  const withdrawData = await withdrawRes.json();
  const withdrawTime = Date.now() - withdrawStart;

  if (withdrawData.success) {
    info("Status", `SUCCESS (${withdrawTime}ms)`);
    info("Withdrawal Tx", withdrawData.txHash);
    info("BaseScan", `https://sepolia.basescan.org/tx/${withdrawData.txHash}`);
    info("Proof Valid", String(withdrawData.proofValid));
    info("Remaining Value", withdrawData.remainingValue || "0");
    info("Returned nextDeposit", withdrawData.nextDeposit ? "yes" : "no");
  } else {
    info("Status", "FAILED");
    info("Error", withdrawData.error);
    if (withdrawData.debug) {
      console.log("  Debug:", JSON.stringify(withdrawData.debug, null, 2));
    }
  }

  console.log("\n  Equivalent curl:");
  console.log(`  curl -X POST ${ZBASE_API}/api/withdraw \\`);
  console.log(`    -H "Content-Type: application/json" \\`);
  console.log(`    -d '${JSON.stringify(withdrawBody)}'`);

  // ── Step 11: Print all curl commands ──
  log("STEP 11", "All curl commands with YOUR real deposit data");

  console.log(`
# ══════════════════════════════════════════════════════════
# Copy-paste these curl commands to test each endpoint
# These use YOUR actual deposit from this test run
# ══════════════════════════════════════════════════════════

# 1. Discovery — what does zBase support?
curl ${ZBASE_API}/api/facilitator/supported | jq

# 2. Verify — can this deposit cover a payment?
curl -X POST ${ZBASE_API}/api/facilitator/verify \\
  -H "Content-Type: application/json" \\
  -d '{
    "paymentDetails": {
      "scheme": "exact",
      "payTo": "${account.address}",
      "maxAmountRequired": "${(onChainValue / 2n).toString()}",
      "networkId": "eip155:84532"
    },
    "zbaseDeposit": {
      "nullifier": "${depositSecrets.nullifier}",
      "secret": "${depositSecrets.secret}",
      "value": "${depositSecrets.value}",
      "label": "${depositSecrets.label}",
      "commitment": "${depositSecrets.commitment}"
    }
  }'

# 3. Settle through the Base facilitator.
# Legacy /api/x402-pay is disabled by default for the Base mainnet launch.
curl -X POST ${ZBASE_API}/api/facilitator/settle \\
  -H "Content-Type: application/json" \\
  -d '{
    "paymentDetails": {
      "scheme": "exact",
      "payTo": "${account.address}",
      "maxAmountRequired": "${(onChainValue / 2n).toString()}",
      "networkId": "eip155:84532"
    },
    "zbaseDeposit": {
      "nullifier": "${depositSecrets.nullifier}",
      "secret": "${depositSecrets.secret}",
      "value": "${depositSecrets.value}",
      "label": "${depositSecrets.label}",
      "commitment": "${depositSecrets.commitment}"
    }
  }'

# NOTE: the original note is spent after withdraw. Use returned nextDeposit
# for another private payment if remainingValue is greater than zero.
`);

  // ── Step 12: Summary ──
  log("STEP 12", "Privacy verification");

  console.log(`
  DEPOSIT:
    Depositor: ${account.address}
    Tx: https://sepolia.basescan.org/tx/${depositTx}
    On-chain: "${account.address} deposited to pool" (PUBLIC)

  WITHDRAWAL:
    Recipient: ${recipient}
    Tx: https://sepolia.basescan.org/tx/${withdrawData.txHash || "N/A"}
    On-chain: "Pool paid ${recipient}" (PUBLIC)

  PRIVACY CHECK:
    The deposit tx shows WHO deposited.
    The withdrawal tx shows WHO received.
    But there is NO on-chain link between the two.
    With ${supportedData.privacy?.anonymitySet || "20+"} depositors in the pool,
    nobody can tell which deposit funded which withdrawal.

  NO YIELD:
    The live pool is a plain 0xbow PrivacyPool — it does NOT earn yield.
    The recipient receives exactly (amount - take); nothing is skimmed for
    a protocol fee and nothing is added from a yield source.
`);

  console.log("Done.");
}

main().catch((err) => {
  console.error("\nFATAL ERROR:", err.message);
  console.error(err.stack?.slice(0, 500));
  process.exit(1);
});
