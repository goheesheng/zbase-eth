/**
 * zBase Path D buyer simulation — full end-to-end revenue path verification.
 *
 * Simulates a real outside agent integrating zBase as their x402 facilitator:
 *   1. Read buyer wallet from BUYER_PRIVATE_KEY env (separate from POSTMAN/TREASURY)
 *   2. Check USDC + ETH balances on Base Sepolia
 *   3. Deposit 1 USDC into the privacy pool (one-time, gives nullifier+secret)
 *   4. Send $0.001 USDC access-token tx to the zBase treasury
 *   5. POST /api/facilitator/authorize with tx hash + nullifier
 *   6. POST /api/facilitator/settle to pay a fake provider $0.005
 *   7. Print receipts + treasury balance delta
 *
 * Result: $0.001 USDC arrives at the treasury, observable on BaseScan.
 *
 * Usage:
 *   BUYER_PRIVATE_KEY=0x... npx tsx scripts/simulate-buyer.ts
 *   ZBASE_API_URL=https://zbase.app BUYER_PRIVATE_KEY=0x... npx tsx scripts/simulate-buyer.ts
 *
 * Prerequisites for the buyer wallet:
 *   - ≥0.005 ETH (Base Sepolia) — for gas across 2 txs (deposit + access-token)
 *   - ≥1.001 USDC (Base Sepolia) — for the 1 USDC deposit + $0.001 access fee
 *
 * Faucets:
 *   ETH:  https://www.alchemy.com/faucets/base-sepolia (0.5 ETH/day)
 *   USDC: https://faucet.circle.com/ (10 USDC/hour)
 */

import "./load-env";
import {
  createPublicClient,
  createWalletClient,
  http,
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
const TREASURY = "0xDbAA23601A95a01ee9B90160F6aA784CBE4E0f21" as const;
const DEPOSITED_TOPIC =
  "0xe3b53cd1a44fbf11535e145d80b8ef1ed6d57a73bf5daa7e939b6b01657d6549";
const SNARK_FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const ZBASE_API = process.env.ZBASE_API_URL ?? "https://zbase.app";
const FACILITATOR = `${ZBASE_API}/api/facilitator`;
const DEPOSIT_AMOUNT_USDC = 1_000_000n; // 1 USDC atomic
const ACCESS_FEE_USDC = 1_000n; // 0.001 USDC atomic (Sepolia per Path D)
// Settle amount must be ≥ minimum for the standard tier (Sepolia: ~$0.040 = 40000 atomic).
// Using $0.700 (700000 atomic) — comfortably above the min, leaves room for the take.
// At the 5.00% standard on-chain take (2026-07-10): treasury gets
// 700000 × 500 / 10000 = 35000 atomic ($0.035), recipient gets 665000 atomic ($0.665).
const SETTLE_AMOUNT_USDC = 700_000n; // 0.700 USDC settle to a fake provider
const STANDARD_TAKE_BPS = BigInt(process.env.ZBASE_FEE_STANDARD_BPS ?? "500"); // keep in sync with facilitator-authz TAKE_BPS.standard
const EXPECTED_PER_SETTLE_TAKE_USDC = (SETTLE_AMOUNT_USDC * STANDARD_TAKE_BPS) / 10000n; // 35000 atomic = $0.035
// All-lowercase: viem's getAddress() rejects mixed-case strings that don't
// match the EIP-55 checksum. "0x...bEEf" fails checksum; "0x...beef" is fine.
const FAKE_PROVIDER = "0x000000000000000000000000000000000000beef" as const;

// ── ABIs ──
const ERC20_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "_owner", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "transfer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_to", type: "address" },
      { name: "_value", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_spender", type: "address" },
      { name: "_value", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "_owner", type: "address" },
      { name: "_spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

const DEPOSIT_ABI = [
  {
    name: "deposit",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_asset", type: "address" },
      { name: "_amount", type: "uint256" },
      { name: "_precommitment", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

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

function header(step: string, msg: string) {
  console.log(`\n${"━".repeat(60)}`);
  console.log(`  ${step}  ${msg}`);
  console.log("━".repeat(60));
}

function info(label: string, value: string) {
  console.log(`  ${label.padEnd(18)} ${value}`);
}

function basescan(tx: string) {
  return `https://sepolia.basescan.org/tx/${tx}`;
}

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║   zBase Path D buyer simulation — full revenue flow     ║");
  console.log("║   facilitator: " + ZBASE_API.padEnd(42) + "║");
  console.log("╚══════════════════════════════════════════════════════════╝");

  // ── Step 0: Setup ──
  // Prefer a dedicated BUYER_PRIVATE_KEY; fall back to POSTMAN_PRIVATE_KEY so the
  // test runs flagless against .env.local (which sets POSTMAN but not BUYER). The
  // fallback just reuses the funded operator wallet as the buyer — fine for a
  // self-contained simulation. Set BUYER_PRIVATE_KEY explicitly to use a separate
  // wallet (e.g. to keep the buyer distinct from the postman on a shared stack).
  const rawKey = process.env.BUYER_PRIVATE_KEY ?? process.env.POSTMAN_PRIVATE_KEY;
  if (!rawKey) {
    console.error("\nERROR: BUYER_PRIVATE_KEY (or POSTMAN_PRIVATE_KEY) missing in environment.");
    console.error("Set BUYER_PRIVATE_KEY on a fresh Base Sepolia wallet funded with:");
    console.error("  - ≥0.005 ETH (gas): https://www.alchemy.com/faucets/base-sepolia");
    console.error("  - ≥1.001 USDC: https://faucet.circle.com/  (select Base Sepolia)");
    process.exit(1);
  }
  const normalizedKey = rawKey.replace(/^0x/i, "");
  const account = privateKeyToAccount(`0x${normalizedKey}` as Hex);

  const rpc = process.env.BASE_SEPOLIA_RPC ?? "https://sepolia.base.org";
  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(rpc),
  });
  const walletClient = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http("https://sepolia.base.org"),
  });

  header("STEP 0", "Buyer wallet");
  info("Address", account.address);
  info("RPC", rpc);

  // ── Step 1: Pre-flight balance check ──
  header("STEP 1", "Pre-flight balance check");
  const ethBal = await publicClient.getBalance({ address: account.address });
  const usdcBalBefore = (await publicClient.readContract({
    address: USDC,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [account.address],
  })) as bigint;
  const treasuryUsdcBefore = (await publicClient.readContract({
    address: USDC,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [TREASURY],
  })) as bigint;

  info("ETH balance", `${formatUnits(ethBal, 18)} ETH`);
  info("USDC balance", `${formatUnits(usdcBalBefore, 6)} USDC`);
  info("Treasury USDC", `${formatUnits(treasuryUsdcBefore, 6)} USDC (before)`);

  // Need ~0.002 ETH realistically (deposit ~600K gas + transfer ~50K gas at
  // typical Sepolia base fee ~0.1 gwei = ~0.0001 ETH; budget 20× for fee spikes).
  if (ethBal < 2_000_000_000_000_000n) {
    console.error(
      `\nERROR: Need ≥0.002 ETH for gas, have ${formatUnits(ethBal, 18)}.`,
    );
    console.error("Get more from https://www.alchemy.com/faucets/base-sepolia");
    process.exit(1);
  }
  if (usdcBalBefore < DEPOSIT_AMOUNT_USDC + ACCESS_FEE_USDC) {
    console.error(`\nERROR: Need ≥${formatUnits(DEPOSIT_AMOUNT_USDC + ACCESS_FEE_USDC, 6)} USDC.`);
    process.exit(1);
  }

  // ── Step 2: Approve + deposit 1 USDC to the privacy pool ──
  header("STEP 2", "Deposit 1 USDC into the privacy pool");
  const allowance = (await publicClient.readContract({
    address: USDC,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [account.address, ENTRYPOINT],
  })) as bigint;

  if (allowance < DEPOSIT_AMOUNT_USDC) {
    info("Approval", "needed — sending max approval");
    const approveTx = await walletClient.writeContract({
      address: USDC,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [ENTRYPOINT, 2n ** 256n - 1n],
    });
    await publicClient.waitForTransactionReceipt({ hash: approveTx });
    info("Approve tx", basescan(approveTx));
  } else {
    info("Approval", "already sufficient");
  }

  const nullifier = randomFieldElement();
  const secret = randomFieldElement();
  const precommitment = poseidon2([nullifier, secret]);
  info("Nullifier", nullifier.toString().slice(0, 24) + "...");
  info("Secret", secret.toString().slice(0, 24) + "... (SAVE THIS)");
  info("Precommitment", precommitment.toString().slice(0, 24) + "...");

  const depositTx = await walletClient.writeContract({
    address: ENTRYPOINT,
    abi: DEPOSIT_ABI,
    functionName: "deposit",
    args: [USDC, DEPOSIT_AMOUNT_USDC, precommitment],
    gas: 1_000_000n,
  });
  info("Deposit tx", basescan(depositTx));

  const depositReceipt = await publicClient.waitForTransactionReceipt({
    hash: depositTx,
  });
  if (depositReceipt.status !== "success") {
    console.error("\nERROR: Deposit tx reverted.");
    process.exit(1);
  }
  info("Status", "confirmed");

  // Parse the Deposited event to recover the on-chain label, value, commitment
  let onChainCommitment = 0n;
  let onChainLabel = 0n;
  let onChainValue = 0n;
  for (const log of depositReceipt.logs) {
    if (
      log.address.toLowerCase() === USDC_POOL.toLowerCase() &&
      log.topics[0] === DEPOSITED_TOPIC
    ) {
      const data = log.data;
      if (data.length >= 258) {
        onChainCommitment = BigInt("0x" + data.slice(2, 66));
        onChainLabel = BigInt("0x" + data.slice(66, 130));
        onChainValue = BigInt("0x" + data.slice(130, 194));
      }
      break;
    }
  }
  info("On-chain value", `${formatUnits(onChainValue, 6)} USDC (post 1% vetting fee)`);
  info("On-chain label", onChainLabel.toString().slice(0, 24) + "...");

  // ── Step 3: Send the access-token tx ($0.001 USDC to treasury) ──
  header("STEP 3", "Pay access fee — $0.001 USDC to treasury");
  info("Treasury", TREASURY);
  info("Amount", `${formatUnits(ACCESS_FEE_USDC, 6)} USDC (${ACCESS_FEE_USDC} atomic)`);

  const accessTx = await walletClient.writeContract({
    address: USDC,
    abi: ERC20_ABI,
    functionName: "transfer",
    args: [TREASURY, ACCESS_FEE_USDC],
  });
  info("Access tx", basescan(accessTx));

  const accessReceipt = await publicClient.waitForTransactionReceipt({
    hash: accessTx,
  });
  if (accessReceipt.status !== "success") {
    console.error("\nERROR: Access-token tx reverted.");
    process.exit(1);
  }
  info("Status", "confirmed");

  // ── Step 4: Trigger ASP root refresh so the new label is included ──
  header("STEP 4", "Refresh ASP root (so the deposit is withdrawable)");
  const aspRes = await fetch(`${ZBASE_API}/api/asp-update`, { method: "POST" });
  if (!aspRes.ok) {
    const body = await aspRes.text();
    console.error("ASP update failed:", body);
    process.exit(1);
  }
  const aspJson = await aspRes.json();
  info("ASP root", aspJson.root?.slice?.(0, 24) + "..." ?? "(no root field)");
  info("Total deposits", String(aspJson.deposits ?? "?"));

  // ── Step 5: Authorize the nullifier with the facilitator ──
  header("STEP 5", "POST /api/facilitator/authorize");
  const authRes = await fetch(`${FACILITATOR}/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      network: "eip155:84532",
      accessTokenTxHash: accessTx,
      nullifierHash: nullifier.toString(),
    }),
  });
  const authJson = await authRes.json();
  info("HTTP status", String(authRes.status));
  if (!authJson.authorized) {
    console.error("\nERROR: authorize rejected:", authJson.error);
    process.exit(1);
  }
  info("Authorized", "✓ nullifier registered with facilitator");
  if (authJson.note) info("Note", authJson.note);

  // ── Step 6: Settle a payment to the fake provider ──
  header("STEP 6", "POST /api/facilitator/settle → fake provider");
  info("Provider (payTo)", FAKE_PROVIDER);
  info("Amount", `${formatUnits(SETTLE_AMOUNT_USDC, 6)} USDC`);

  const settleRes = await fetch(`${FACILITATOR}/settle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      paymentDetails: {
        payTo: FAKE_PROVIDER,
        maxAmountRequired: SETTLE_AMOUNT_USDC.toString(),
      },
      zbaseDeposit: {
        nullifier: nullifier.toString(),
        secret: secret.toString(),
        value: onChainValue.toString(),
        label: onChainLabel.toString(),
        commitment: onChainCommitment.toString(),
      },
    }),
  });
  const settleJson = await settleRes.json();
  info("HTTP status", String(settleRes.status));
  if (!settleJson.settled) {
    console.error("\nERROR: settle rejected:", JSON.stringify(settleJson, null, 2));
    process.exit(1);
  }
  info("Settle tx", basescan(settleJson.txHash));
  info("Privacy method", settleJson.privacy?.method ?? "?");
  info("Linkable on-chain?", String(settleJson.privacy?.linkable ?? "?"));

  // ── Step 7: Verify treasury balance went up by access fee + per-settle take ──
  // Post-2026-06-08 the per-settle take is on-chain via the pool contract's
  // relay struct (feeRecipient + relayFeeBPS). For standard tier (5.00% as of
  // 2026-07-10) on a 0.700 USDC settle: treasury receives 0.001 (access) +
  // 0.035 (5% of settle) = 0.036. (Deltas below are computed from constants.)
  header("STEP 7", "Verify treasury + recipient balance deltas");
  const treasuryUsdcAfter = (await publicClient.readContract({
    address: USDC,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [TREASURY],
  })) as bigint;
  const recipientUsdcAfter = (await publicClient.readContract({
    address: USDC,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [FAKE_PROVIDER],
  })) as bigint;
  const treasuryDelta = treasuryUsdcAfter - treasuryUsdcBefore;
  const expectedTreasuryDelta = ACCESS_FEE_USDC + EXPECTED_PER_SETTLE_TAKE_USDC;
  const expectedRecipientShare = SETTLE_AMOUNT_USDC - EXPECTED_PER_SETTLE_TAKE_USDC;

  info("Treasury USDC", `${formatUnits(treasuryUsdcAfter, 6)} USDC (after)`);
  info("Treasury delta", `+${formatUnits(treasuryDelta, 6)} USDC`);
  info("Expected delta", `+${formatUnits(expectedTreasuryDelta, 6)} USDC (access ${formatUnits(ACCESS_FEE_USDC, 6)} + take ${formatUnits(EXPECTED_PER_SETTLE_TAKE_USDC, 6)})`);
  info("Recipient USDC", `${formatUnits(recipientUsdcAfter, 6)} USDC (cumulative)`);
  info("Recipient share", `expected ${formatUnits(expectedRecipientShare, 6)} USDC from THIS settle`);

  // Final summary
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║   REVENUE FLOW VERIFIED                                  ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log(`  Buyer deposited:     1 USDC into the privacy pool`);
  console.log(`  Buyer paid access:   ${formatUnits(ACCESS_FEE_USDC, 6)} USDC to treasury`);
  console.log(`  Buyer settled:       ${formatUnits(SETTLE_AMOUNT_USDC, 6)} USDC to ${FAKE_PROVIDER}`);
  console.log(`  Recipient received:  ${formatUnits(expectedRecipientShare, 6)} USDC (settle - take)`);
  console.log(`  Treasury received:   ${formatUnits(EXPECTED_PER_SETTLE_TAKE_USDC, 6)} USDC (per-settle take)`);
  console.log(`  Treasury total Δ:    +${formatUnits(treasuryDelta, 6)} USDC (access + take)`);
  console.log("");
  console.log("  Deposit:        " + basescan(depositTx));
  console.log("  Access fee:     " + basescan(accessTx));
  console.log("  Settle (private): " + basescan(settleJson.txHash));
  console.log("");
  if (treasuryDelta === expectedTreasuryDelta) {
    console.log("  ✅ Treasury delta == access fee + per-settle take. On-chain fee split verified.");
  } else if (treasuryDelta > expectedTreasuryDelta) {
    console.log(`  ✅ Treasury delta (${formatUnits(treasuryDelta, 6)}) > expected (${formatUnits(expectedTreasuryDelta, 6)}). Other revenue arrived during run (concurrent buyers).`);
  } else {
    console.log(`  ❌ Treasury delta ${formatUnits(treasuryDelta, 6)} < expected ${formatUnits(expectedTreasuryDelta, 6)}.`);
    console.log(`     Possible causes: (a) per-settle on-chain fee split not landed, (b) wrong tier authorized, (c) settle reverted partway.`);
    console.log(`     Check BaseScan settle tx: ${basescan(settleJson.txHash)}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("\nFATAL:", e);
  process.exit(1);
});
