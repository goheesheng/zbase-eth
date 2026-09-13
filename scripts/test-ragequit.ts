import "./load-env";
/**
 * test-ragequit.ts — on-chain deposit → ragequit round-trip on Base Sepolia.
 *
 * Proves the PUBLIC self-exit (escape hatch) works end-to-end against the live
 * 0xbow pool: deposit USDC → recover the on-chain label → POST /api/ragequit to
 * build the proof + calldata → submit the ragequit tx FROM THE DEPOSITOR WALLET
 * → confirm the USDC came back to that wallet.
 *
 * Ragequit MUST be signed by the original depositor (the pool enforces
 * OnlyOriginalDepositor), so this script signs with the same wallet that
 * deposited — exactly what the UI does via the connected wallet.
 *
 * Run:
 *   RAGEQUIT_PRIVATE_KEY=0x<funded sepolia key> \
 *   ZBASE_API_URL=http://localhost:3009 \
 *   npx tsx --env-file=.env.local scripts/test-ragequit.ts
 *
 * Needs: ~0.003 ETH (gas, 2 txs) + ~1 USDC (the deposit) on Base Sepolia.
 * Falls back to POSTMAN_PRIVATE_KEY if RAGEQUIT_PRIVATE_KEY is unset.
 */
import {
  createWalletClient,
  createPublicClient,
  http,
  parseUnits,
  formatUnits,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { poseidon1, poseidon2 } from "poseidon-lite";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
const POOL = "0x4ebcfeaf661a25f103b3d1f16be5a7668ab0935a" as const;
// Deposits go THROUGH the Entrypoint (the pool's deposit() is onlyEntrypoint).
// approve() the Entrypoint (it does the safeTransferFrom), and call
// Entrypoint.deposit(asset, value, precommitment).
const ENTRYPOINT = "0x598ffaac79ae29b1aae571fd91899d4492183688" as const;
const DEPOSITED_TOPIC =
  "0xe3b53cd1a44fbf11535e145d80b8ef1ed6d57a73bf5daa7e939b6b01657d6549";
const DEPOSIT_AMOUNT = parseUnits("1", 6); // 1 USDC
const ZBASE_API = process.env.ZBASE_API_URL ?? "http://localhost:3009";

const ERC20_ABI = [
  { name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "a", type: "uint256" }], outputs: [{ type: "bool" }] },
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "o", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;
const DEPOSIT_ABI = [
  { name: "deposit", type: "function", stateMutability: "nonpayable", inputs: [{ name: "_asset", type: "address" }, { name: "_amount", type: "uint256" }, { name: "_precommitment", type: "uint256" }], outputs: [{ type: "uint256" }] },
] as const;

const log = (k: string, v: string) => console.log(`  ${k.padEnd(20)} ${v}`);
const bs = (h: string) => `https://sepolia.basescan.org/tx/${h}`;

async function main() {
  const raw = process.env.RAGEQUIT_PRIVATE_KEY ?? process.env.POSTMAN_PRIVATE_KEY;
  if (!raw) {
    console.error("ERROR: set RAGEQUIT_PRIVATE_KEY (or POSTMAN_PRIVATE_KEY) — a funded Base Sepolia wallet.");
    process.exit(1);
  }
  const account = privateKeyToAccount(`0x${raw.replace(/^0x/i, "")}` as Hex);
  const rpc = process.env.BASE_SEPOLIA_RPC ?? "https://sepolia.base.org";
  const pub = createPublicClient({ chain: baseSepolia, transport: http(rpc) });
  const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(rpc) });

  console.log("\n╔══ ragequit round-trip (Base Sepolia) ══╗");
  log("Depositor", account.address);
  log("Facilitator", ZBASE_API);

  const balBefore = await pub.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] }) as bigint;
  log("USDC before", formatUnits(balBefore, 6));
  if (balBefore < DEPOSIT_AMOUNT) { console.error("\nERROR: need ≥1 USDC. Faucet: faucet.circle.com (Base Sepolia)."); process.exit(1); }

  // ── 1. Deposit ──
  console.log("\n── STEP 1: deposit 1 USDC ──");
  const nullifier = BigInt("0x" + Buffer.from(crypto.getRandomValues(new Uint8Array(31))).toString("hex"));
  const secret = BigInt("0x" + Buffer.from(crypto.getRandomValues(new Uint8Array(31))).toString("hex"));
  const precommitment = poseidon2([nullifier, secret]);

  // approve the ENTRYPOINT (it pulls the funds), not the pool.
  const approveTx = await wallet.writeContract({ address: USDC, abi: ERC20_ABI, functionName: "approve", args: [ENTRYPOINT, DEPOSIT_AMOUNT] });
  await pub.waitForTransactionReceipt({ hash: approveTx });
  log("Approve", bs(approveTx));

  // deposit THROUGH the entrypoint (pool.deposit is onlyEntrypoint).
  const depositTx = await wallet.writeContract({ address: ENTRYPOINT, abi: DEPOSIT_ABI, functionName: "deposit", args: [USDC, DEPOSIT_AMOUNT, precommitment], gas: 1_000_000n });
  const rcpt = await pub.waitForTransactionReceipt({ hash: depositTx });
  if (rcpt.status !== "success") { console.error("\nERROR: deposit reverted."); process.exit(1); }
  log("Deposit", bs(depositTx));

  // Recover the on-chain label + value from the Deposited event.
  let label = 0n, value = 0n;
  for (const l of rcpt.logs) {
    if (l.address.toLowerCase() === POOL.toLowerCase() && l.topics[0] === DEPOSITED_TOPIC && l.data.length >= 194) {
      label = BigInt("0x" + l.data.slice(66, 130));
      value = BigInt("0x" + l.data.slice(130, 194));
      break;
    }
  }
  if (label === 0n) { console.error("\nERROR: could not parse Deposited event."); process.exit(1); }
  log("On-chain value", `${formatUnits(value, 6)} USDC (post fee)`);
  log("On-chain label", label.toString().slice(0, 20) + "…");

  // Sanity: nullifierHash the pool will see (informational).
  log("nullifierHash", poseidon1([nullifier]).toString().slice(0, 20) + "…");

  // ── 2. Build the ragequit proof + calldata via the facilitator ──
  console.log("\n── STEP 2: POST /api/ragequit (build proof + calldata) ──");
  const res = await fetch(`${ZBASE_API}/api/ragequit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      nullifier: nullifier.toString(),
      secret: secret.toString(),
      value: value.toString(),
      label: label.toString(),
      depositor: account.address,
    }),
  });
  const rq = await res.json();
  if (!rq.ragequit || !rq.to || !rq.data) { console.error("\nERROR: /api/ragequit failed:", JSON.stringify(rq, null, 2)); process.exit(1); }
  log("calldata", rq.data.slice(0, 26) + "…");
  log("to (pool)", rq.to);

  // ── 3. Submit the ragequit tx FROM THE DEPOSITOR WALLET (raw calldata) ──
  console.log("\n── STEP 3: submit ragequit (depositor wallet) ──");
  const rqTx = await wallet.sendTransaction({ to: rq.to as `0x${string}`, data: rq.data as Hex, gas: 800_000n });
  const rqRcpt = await pub.waitForTransactionReceipt({ hash: rqTx });
  log("Ragequit tx", bs(rqTx));
  log("Status", rqRcpt.status);
  if (rqRcpt.status !== "success") { console.error("\n❌ Ragequit tx REVERTED — the escape hatch does NOT work as-is. Investigate (verifier / OnlyOriginalDepositor / signal order)."); process.exit(1); }

  // ── 4. Verify funds returned ──
  const balAfter = await pub.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] }) as bigint;
  const returned = balAfter - (balBefore - DEPOSIT_AMOUNT);
  console.log("\n╔══ RESULT ══╗");
  log("USDC after", formatUnits(balAfter, 6));
  log("Returned", `${formatUnits(returned, 6)} USDC`);
  log("Expected ~", `${formatUnits(value, 6)} USDC (the post-fee deposit value)`);
  if (returned >= value - 1n) {
    console.log("\n✅ RAGEQUIT WORKS — depositor reclaimed their funds publicly. The escape hatch is real.");
  } else {
    console.log("\n⚠️ Ragequit tx succeeded but returned less than expected — check the value math.");
  }
}

main().catch((e) => { console.error("\nFATAL:", e); process.exit(1); });
