/**
 * zBase Decoy Withdrawal Scheduler — Shipment A.2 (mechanism 2)
 *
 * Why: A passive observer of the zBase pool can apply the FIFO heuristic
 * (arXiv 2510.09433): for each withdrawal at time T, the smallest-δ deposit
 * at time T-δ is the most likely source. On Tornado Cash this re-links
 * 15-22% of withdrawals using nothing but timestamps. To break that
 * heuristic we inject *real* withdrawals at Poisson-distributed intervals
 * (mean 4 min, ~15/hr) so the heuristic sees one true deposit hidden in a
 * cloud of decoy withdrawals.
 *
 * The decoys are real on-chain Groth16 withdrawals from the postman wallet's
 * own deposits to one of 10 deterministically-derived burn addresses. A
 * passive chain analyst cannot distinguish a decoy from a real user
 * payment — that's the whole point.
 *
 * Usage:
 *   tsx scripts/decoy-scheduler.ts                    # run, real txs
 *   tsx scripts/decoy-scheduler.ts --dry-run          # plan but don't send
 *   tsx scripts/decoy-scheduler.ts --once             # fire once and exit
 *   tsx scripts/decoy-scheduler.ts --mean-seconds 60  # custom Poisson mean
 *
 * Env:
 *   POSTMAN_PRIVATE_KEY        — funded wallet that holds the decoy deposits
 *   BASE_SEPOLIA_RPC           — read RPC (Infura ok)
 *   HYPERSYNC_TOKEN            — required by /api/withdraw
 *   USDC_POOL_ADDRESS          — defaults to the current plain 0xbow USDC pool
 *   ZBASE_API                  — defaults to http://localhost:3009
 *   ZBASE_DECOY_AMOUNT_USDC    — per-decoy amount in USDC (default 0.01)
 *   ZBASE_DECOY_DEPOSIT_FILE   — JSON file storing the postman's reusable
 *                                deposit notes (auto-created)
 *   MAX_DAILY_BUDGET_USD       — daily spend cap (default 5)
 */

import "./load-env";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  formatUnits,
  keccak256,
  toHex,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { poseidon2 } from "poseidon-lite";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Config ──
const ENTRYPOINT = "0x598ffaac79ae29b1aae571fd91899d4492183688" as const;
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
const DEFAULT_POOL = "0x4ebcfeaf661a25f103b3d1f16be5a7668ab0935a" as const;
const SNARK_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const DEPOSITED_TOPIC = keccak256(toHex("Deposited(address,uint256,uint256,uint256,uint256)"));

const POOL_ADDRESS = (process.env.USDC_POOL_ADDRESS || DEFAULT_POOL) as `0x${string}`;
const ZBASE_API = process.env.ZBASE_API || "http://localhost:3009";
const STATE_FILE =
  process.env.ZBASE_DECOY_DEPOSIT_FILE ||
  join(__dirname, "..", ".decoy-state", "deposits.json");
const BURN_FILE = join(__dirname, "burn-addresses.json");
const DECOY_AMOUNT_USDC = process.env.ZBASE_DECOY_AMOUNT_USDC || "0.01";
const MAX_DAILY_BUDGET_USD = Number.parseFloat(process.env.MAX_DAILY_BUDGET_USD || "5");

// ── Args ──
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const RUN_ONCE = args.includes("--once");
const MEAN_SECONDS = (() => {
  const i = args.indexOf("--mean-seconds");
  if (i !== -1 && args[i + 1]) {
    const v = Number.parseFloat(args[i + 1]);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return 240; // 4 minutes → ~15/hr
})();

// ── Types ──
type DepositNote = {
  nullifier: string;
  secret: string;
  value: string; // remaining atomic value (USDC, 6 decimals)
  label: string;
  commitment: string;
  depositTxHash?: string;
  depositTimestamp?: number; // unix seconds, populated lazily
};

type State = {
  pool: string;
  notes: DepositNote[];
  spentTodayUsd: number;
  spentDayStartUnix: number;
  lastDecoyAt?: number;
  totalDecoysSent: number;
};

// ── Helpers ──
function info(msg: string) {
  console.log(`[decoy] ${msg}`);
}
function err(msg: string) {
  console.error(`[decoy][err] ${msg}`);
}

function randomFieldElement(): bigint {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let result = 0n;
  for (const byte of bytes) {
    result = (result << 8n) + BigInt(byte);
  }
  return result % SNARK_FIELD;
}

// Poisson inter-arrival: -mean * ln(U), where U ~ Uniform(0,1)
function poissonDelaySeconds(mean: number): number {
  const u = Math.max(1e-9, Math.random());
  return -mean * Math.log(u);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadBurnAddresses(): string[] {
  const raw = JSON.parse(readFileSync(BURN_FILE, "utf-8"));
  return raw.addresses.map((a: { address: string }) => a.address);
}

function loadState(): State {
  if (!existsSync(STATE_FILE)) {
    return {
      pool: POOL_ADDRESS,
      notes: [],
      spentTodayUsd: 0,
      spentDayStartUnix: Math.floor(Date.now() / 1000),
      totalDecoysSent: 0,
    };
  }
  const raw = JSON.parse(readFileSync(STATE_FILE, "utf-8")) as State;
  // Reset daily budget if we've crossed a 24h boundary
  const now = Math.floor(Date.now() / 1000);
  if (now - raw.spentDayStartUnix > 86400) {
    raw.spentTodayUsd = 0;
    raw.spentDayStartUnix = now;
  }
  return raw;
}

function saveState(state: State): void {
  const dir = dirname(STATE_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ── Deposit creation: postman seeds the pool so the scheduler has notes ──
async function createDecoyDeposit(
  publicClient: ReturnType<typeof createPublicClient>,
  walletClient: ReturnType<typeof createWalletClient>,
  amountUsdc: string,
): Promise<DepositNote> {
  const amountAtomic = parseUnits(amountUsdc, 6);

  // Ensure USDC approval
  const allowance = (await publicClient.readContract({
    address: USDC,
    abi: [{ name: "allowance", type: "function", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] }],
    functionName: "allowance",
    args: [walletClient.account!.address, ENTRYPOINT],
  })) as bigint;
  if (allowance < amountAtomic) {
    info("Approving max USDC to Entrypoint...");
    const tx = await walletClient.writeContract({
      address: USDC,
      abi: [{ name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }],
      functionName: "approve",
      args: [ENTRYPOINT, 2n ** 256n - 1n],
      account: walletClient.account!,
      chain: baseSepolia,
    });
    await publicClient.waitForTransactionReceipt({ hash: tx });
  }

  const nullifier = randomFieldElement();
  const secret = randomFieldElement();
  const precommitment = poseidon2([nullifier, secret]);

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
    args: [USDC, amountAtomic, precommitment],
    gas: 1_000_000n,
    account: walletClient.account!,
    chain: baseSepolia,
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: depositTx });
  if (receipt.status !== "success") {
    throw new Error(`Decoy deposit reverted: ${depositTx}`);
  }

  let commitment = 0n;
  let label = 0n;
  let value = 0n;
  for (const eventLog of receipt.logs) {
    if (
      eventLog.address.toLowerCase() === POOL_ADDRESS.toLowerCase() &&
      eventLog.topics[0] === DEPOSITED_TOPIC
    ) {
      const data = eventLog.data as string;
      if (data.length >= 258) {
        commitment = BigInt("0x" + data.slice(2, 66));
        label = BigInt("0x" + data.slice(66, 130));
        value = BigInt("0x" + data.slice(130, 194));
      }
      break;
    }
  }
  if (label === 0n || commitment === 0n) {
    throw new Error(`Decoy deposit: failed to parse Deposited event in ${depositTx}`);
  }

  const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });

  return {
    nullifier: nullifier.toString(),
    secret: secret.toString(),
    value: value.toString(),
    label: label.toString(),
    commitment: commitment.toString(),
    depositTxHash: depositTx,
    depositTimestamp: Number(block.timestamp),
  };
}

// ── One decoy withdrawal ──
async function fireDecoy(
  state: State,
  burnAddresses: string[],
  publicClient: ReturnType<typeof createPublicClient>,
  walletClient: ReturnType<typeof createWalletClient>,
): Promise<{ txHash?: string; gasUsed?: bigint; skipped?: string }> {
  // Budget check
  const decoyAmountUsd = Number.parseFloat(DECOY_AMOUNT_USDC);
  if (state.spentTodayUsd + decoyAmountUsd > MAX_DAILY_BUDGET_USD) {
    return { skipped: `daily-budget-exceeded (spent=$${state.spentTodayUsd.toFixed(4)}, cap=$${MAX_DAILY_BUDGET_USD})` };
  }

  // Find a note with enough remaining value to cover this decoy
  const amountAtomic = parseUnits(DECOY_AMOUNT_USDC, 6);
  let note = state.notes.find((n) => BigInt(n.value) >= amountAtomic);

  // If no usable note, create a fresh deposit (~1 USDC of capacity)
  if (!note) {
    if (DRY_RUN) {
      return { skipped: "dry-run: would create new decoy deposit" };
    }
    info("No usable note; creating a fresh decoy deposit (1 USDC)...");
    note = await createDecoyDeposit(publicClient, walletClient, "1");
    state.notes.push(note);
    saveState(state);
    info(`Seeded note value=${formatUnits(BigInt(note.value), 6)} USDC tx=${note.depositTxHash}`);
    // Wait past the min-delay window so the upcoming withdrawal isn't rejected
    const waitSec = Number.parseInt(process.env.ZBASE_MIN_DEPOSIT_DELAY_SECONDS || "60", 10) + 5;
    info(`Waiting ${waitSec}s for delay window before first decoy withdrawal...`);
    await sleep(waitSec * 1000);
  }

  const burn = burnAddresses[Math.floor(Math.random() * burnAddresses.length)];

  if (DRY_RUN) {
    info(`dry-run tx=<would-send> burn=${burn} amount=${DECOY_AMOUNT_USDC} USDC`);
    return { skipped: "dry-run" };
  }

  const withdrawBody = {
    nullifier: note.nullifier,
    secret: note.secret,
    value: note.value,
    label: note.label,
    commitment: note.commitment,
    recipient: burn,
    amountAtomic: amountAtomic.toString(),
  };

  const res = await fetch(`${ZBASE_API}/api/withdraw`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(withdrawBody),
  });
  const data = await res.json();

  if (res.status === 429 && data.error === "delay_window_active") {
    return { skipped: `delay-window-active retryAfter=${data.retryAfter}s` };
  }

  if (!res.ok || !data.success) {
    throw new Error(`/api/withdraw failed: ${data.error || res.statusText}`);
  }

  // Roll over to the change note if returned
  if (data.nextDeposit) {
    const idx = state.notes.indexOf(note);
    state.notes[idx] = {
      nullifier: data.nextDeposit.nullifier,
      secret: data.nextDeposit.secret,
      value: data.nextDeposit.value,
      label: data.nextDeposit.label,
      commitment: data.nextDeposit.commitment,
      depositTxHash: note.depositTxHash,
      depositTimestamp: note.depositTimestamp,
    };
  } else {
    // Note fully spent
    state.notes = state.notes.filter((n) => n !== note);
  }

  let gasUsed: bigint | undefined;
  try {
    const r = await publicClient.getTransactionReceipt({ hash: data.txHash as Hex });
    gasUsed = r.gasUsed;
  } catch {
    /* ignore */
  }

  state.spentTodayUsd += decoyAmountUsd;
  state.lastDecoyAt = Math.floor(Date.now() / 1000);
  state.totalDecoysSent += 1;
  saveState(state);

  info(
    `tx=${data.txHash} burn=${burn} amount=${DECOY_AMOUNT_USDC} USDC gas=${gasUsed ?? "?"} ` +
    `spent-today=$${state.spentTodayUsd.toFixed(4)}/${MAX_DAILY_BUDGET_USD}`,
  );

  return { txHash: data.txHash, gasUsed };
}

// ── Main loop ──
async function main() {
  info("zBase decoy scheduler starting");
  info(`pool=${POOL_ADDRESS} mean-interval=${MEAN_SECONDS}s daily-cap=$${MAX_DAILY_BUDGET_USD} dry-run=${DRY_RUN}`);

  const rawKey = process.env.POSTMAN_PRIVATE_KEY;
  const rpcUrl = process.env.BASE_SEPOLIA_RPC;
  if (!rawKey || !rpcUrl) {
    err("Missing POSTMAN_PRIVATE_KEY or BASE_SEPOLIA_RPC in .env");
    process.exit(1);
  }

  const account = privateKeyToAccount(`0x${rawKey.replace(/^0x/i, "")}` as Hex);
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
  const walletClient = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http("https://sepolia.base.org"),
  });

  const burnAddresses = loadBurnAddresses();
  info(`loaded ${burnAddresses.length} burn addresses`);

  const state = loadState();
  info(`loaded state: ${state.notes.length} notes, $${state.spentTodayUsd.toFixed(4)} spent today, ${state.totalDecoysSent} decoys total`);

  // Graceful shutdown
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    info("shutdown signal received, finishing current cycle then exiting");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  let cycle = 0;
  while (!stopping) {
    cycle += 1;
    try {
      const result = await fireDecoy(state, burnAddresses, publicClient, walletClient);
      if (result.skipped) {
        info(`cycle=${cycle} skipped reason=${result.skipped}`);
      }
    } catch (e) {
      err(`cycle=${cycle} error: ${(e as Error).message?.slice(0, 240)}`);
    }

    if (RUN_ONCE) {
      info("--once flag set, exiting");
      return;
    }

    const delaySec = poissonDelaySeconds(MEAN_SECONDS);
    info(`cycle=${cycle} sleeping ${delaySec.toFixed(1)}s until next decoy`);
    // Sleep in small chunks so we can react to SIGINT promptly
    const end = Date.now() + delaySec * 1000;
    while (!stopping && Date.now() < end) {
      await sleep(Math.min(1000, end - Date.now()));
    }
  }

  info("scheduler exited cleanly");
}

main().catch((e) => {
  err(`fatal: ${(e as Error).stack || (e as Error).message}`);
  process.exit(1);
});
