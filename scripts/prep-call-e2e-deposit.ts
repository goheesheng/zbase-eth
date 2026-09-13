/**
 * Prep helper for the Tier-2 on-chain E2E: makes ONE real deposit into the live
 * 0xbow pool (Base Sepolia) with the demo wallet, refreshes the ASP root, and prints
 * the deposit secrets as a JSON blob to paste into CALL_E2E_DEPOSIT.
 *
 * Mirrors scripts/test-full-flow.ts's proven deposit machinery.
 *
 *   npx tsx --env-file=.env.local scripts/prep-call-e2e-deposit.ts
 *
 * TESTNET ONLY. Uses ~1 test USDC.
 */
import { createPublicClient, createWalletClient, http, parseUnits, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { poseidon2 } from "poseidon-lite";
import { randomBytes } from "@noble/hashes/utils";

const SNARK_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
function randomFieldElement(): bigint {
  return BigInt("0x" + Buffer.from(randomBytes(32)).toString("hex")) % SNARK_FIELD;
}

const RPC = process.env.BASE_SEPOLIA_RPC!;
const ENTRYPOINT = "0x598ffaac79ae29b1aae571fd91899d4492183688" as const;
const USDC_POOL = "0x4ebcfeaf661a25f103b3d1f16be5a7668ab0935a" as const;
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
const DEPOSITED_TOPIC = keccak256(toHex("Deposited(address,uint256,uint256,uint256,uint256)"));
const AMOUNT = "1"; // 1 USDC

const ERC20 = [
  { name: "allowance", type: "function", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "a", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
] as const;

async function main() {
  const key = (process.env.DEMO_WALLET_PRIVATE_KEY || "").trim();
  const account = privateKeyToAccount(key as `0x${string}`);
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
  const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http(RPC) });

  const amountRaw = parseUnits(AMOUNT, 6);
  const bal = (await publicClient.readContract({ address: USDC, abi: ERC20, functionName: "balanceOf", args: [account.address] })) as bigint;
  console.log(`Depositor: ${account.address}  USDC balance: ${bal}`);
  if (bal < amountRaw) throw new Error("insufficient test USDC");

  const allowance = (await publicClient.readContract({ address: USDC, abi: ERC20, functionName: "allowance", args: [account.address, ENTRYPOINT] })) as bigint;
  if (allowance < amountRaw) {
    console.log("Approving USDC...");
    const ap = await walletClient.writeContract({ address: USDC, abi: ERC20, functionName: "approve", args: [ENTRYPOINT, (1n << 256n) - 1n] });
    await publicClient.waitForTransactionReceipt({ hash: ap });
  }

  const nullifier = randomFieldElement();
  const secret = randomFieldElement();
  const precommitment = poseidon2([nullifier, secret]);

  console.log("Depositing 1 USDC...");
  const tx = await walletClient.writeContract({
    address: ENTRYPOINT,
    abi: [{ name: "deposit", type: "function", stateMutability: "nonpayable", inputs: [{ name: "_asset", type: "address" }, { name: "_amount", type: "uint256" }, { name: "_precommitment", type: "uint256" }], outputs: [] }],
    functionName: "deposit",
    args: [USDC, amountRaw, precommitment],
    gas: 1_000_000n,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
  if (receipt.status !== "success") throw new Error("deposit reverted");
  console.log(`Deposit tx: ${tx}`);

  // Parse the Deposited event (commitment, label, value) from the pool log.
  // Deposited(address indexed depositor, uint256 commitment, uint256 label, uint256 value, uint256 precommitment)
  let commitment = 0n, label = 0n, value = 0n;
  for (const l of receipt.logs) {
    if (l.address.toLowerCase() === USDC_POOL.toLowerCase() && l.topics[0] === DEPOSITED_TOPIC) {
      const d = l.data as string;
      commitment = BigInt("0x" + d.slice(2, 66));
      label = BigInt("0x" + d.slice(66, 130));
      value = BigInt("0x" + d.slice(130, 194));
      break;
    }
  }
  if (label === 0n || value === 0n) throw new Error("could not parse Deposited event");

  const secrets = { nullifier: nullifier.toString(), secret: secret.toString(), value: value.toString(), label: label.toString(), commitment: commitment.toString() };
  console.log(`\nParsed: value=${value} (post-fee), label set, commitment set.`);
  console.log("\n=== ASP update (so this deposit is withdrawable) ===");
  const base = process.env.CALL_TEST_BASE ?? "http://localhost:3110";
  const asp = await fetch(`${base}/api/asp-update`, { method: "POST", headers: { "Content-Type": "application/json" } }).then(r => r.json()).catch((e) => ({ error: String(e) }));
  console.log("asp-update:", JSON.stringify(asp).slice(0, 200));

  console.log("\n=== ADD TO .env.local (single-quoted) ===");
  console.log(`CALL_E2E_DEPOSIT='${JSON.stringify(secrets)}'`);
  console.log(`CALL_E2E_AMOUNT=${value.toString()}`);
  console.log("=========================================");
}

main().catch((e) => { console.error(e); process.exit(1); });
