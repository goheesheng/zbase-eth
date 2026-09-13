/**
 * e2e-mainnet-buyer.ts — the real end-to-end proof: deposit → private payment → goods,
 * against an UNRELATED third-party x402 seller on Base mainnet.
 *
 * This is the honest MAINNET_E2E: it pays https://relay402.georgespring.workers.dev
 * (a Wayback-Machine snapshot service, $0.001, payTo a stranger — NOT zBase), through the
 * exact `createPrivateFetch` path the buyer quickstart documents. It proves the whole
 * product works with someone who has never heard of zBase.
 *
 * SECRETS STAY LOCAL. Your wallet key is read from env and never printed. The deposit
 * note's nullifier/secret are written to a data/ file (0600) and never logged — only the
 * public commitment, value, tx hash, the seller's data, and the privacy disclosure print.
 *
 * SAFE BY DEFAULT. Without `--go` it is a DRY RUN: it checks balances and prints the plan,
 * moves nothing. Add `--go` to actually deposit and pay real USDC.
 *
 * Usage:
 *   BUYER_PRIVATE_KEY=0x...  npx tsx scripts/e2e-mainnet-buyer.ts            # dry run
 *   BUYER_PRIVATE_KEY=0x...  npx tsx scripts/e2e-mainnet-buyer.ts --go       # real: deposit $2, pay $0.001
 *   DEPOSIT_ATOMIC=2000000  BASE_MAINNET_RPC=https://...  ... --go           # overrides
 */
import fs from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  parseEventLogs,
  formatUnits,
  getAddress,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { createFacilitatorClient, depositConfigFor } from "../packages/core/src/index.ts";

const GO = process.argv.includes("--go");
const KEY = process.env.BUYER_PRIVATE_KEY as Hex | undefined;
const RPC = process.env.BASE_MAINNET_RPC ?? "https://mainnet.base.org";
const DEPOSIT_ATOMIC = BigInt(process.env.DEPOSIT_ATOMIC ?? "1000000"); // $1.00 (the on-chain pool minimum). Override e.g. DEPOSIT_ATOMIC=1500000 for $1.50.
const FACILITATOR = "https://zbase.app";
// A real, unrelated third-party x402 seller on Base ($0.001). GET with query params.
const SELLER =
  "https://relay402.georgespring.workers.dev/api/wayback-snapshot?url=https://openai.com&timestamp=20200101";

const USDC_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);
const DEPOSIT_ABI = parseAbi(["function deposit(address asset, uint256 amount, uint256 precommitment) returns (uint256)"]);
const DEPOSITED_ABI = parseAbi([
  "event Deposited(address indexed _depositor, uint256 _commitment, uint256 _label, uint256 _value, uint256 _precommitmentHash)",
]);

const usd = (v: bigint) => "$" + formatUnits(v, 6);

async function main() {
  if (!KEY) throw new Error("Set BUYER_PRIVATE_KEY (a Base-mainnet wallet with ~$2 USDC + a little ETH for gas). It is never printed.");

  const cfg = depositConfigFor("eip155:8453"); // entrypoint, asset (USDC), privacyPool, deployBlock
  const account = privateKeyToAccount(KEY);
  const pub = createPublicClient({ chain: base, transport: http(RPC) });
  const usdc = getAddress(cfg.asset);
  const entrypoint = getAddress(cfg.entrypoint);

  const [eth, bal, allowance] = await Promise.all([
    pub.getBalance({ address: account.address }),
    pub.readContract({ address: usdc, abi: USDC_ABI, functionName: "balanceOf", args: [account.address] }),
    pub.readContract({ address: usdc, abi: USDC_ABI, functionName: "allowance", args: [account.address, entrypoint] }),
  ]);

  console.log("zBase mainnet buyer E2E", GO ? "(LIVE — will move real funds)" : "(DRY RUN — add --go to execute)");
  console.log("  buyer wallet :", account.address);
  console.log("  ETH (gas)    :", formatUnits(eth, 18).slice(0, 8));
  console.log("  USDC balance :", usd(bal));
  console.log("  deposit      :", usd(DEPOSIT_ATOMIC), "→ privacy pool");
  console.log("  then pay     :", "$0.001 → Wayback snapshot (unrelated third-party seller)");
  console.log("  seller       :", SELLER.split("?")[0]);
  console.log();

  if (bal < DEPOSIT_ATOMIC) throw new Error(`USDC balance ${usd(bal)} < deposit ${usd(DEPOSIT_ATOMIC)}. Fund the wallet.`);
  if (eth === 0n) throw new Error("No ETH for gas. Send a little ETH to the buyer wallet on Base.");

  if (!GO) {
    console.log("DRY RUN complete. Balances look sufficient. Re-run with --go to deposit and pay.");
    return;
  }

  const wallet = createWalletClient({ account, chain: base, transport: http(RPC) });
  const zbase = createFacilitatorClient({ baseUrl: FACILITATOR, network: "eip155:8453" });

  // 1. Approve USDC to the entrypoint (only if needed).
  if (allowance < DEPOSIT_ATOMIC) {
    console.log("→ approving USDC…");
    const a = await wallet.writeContract({ address: usdc, abi: USDC_ABI, functionName: "approve", args: [entrypoint, DEPOSIT_ATOMIC] });
    await pub.waitForTransactionReceipt({ hash: a });
  }

  // 2. Deposit. prepareDeposit gives the precommitment + the secrets to KEEP.
  const prep = zbase.prepareDeposit(DEPOSIT_ATOMIC);
  console.log("→ depositing", usd(DEPOSIT_ATOMIC), "…");
  const depHash = await wallet.writeContract({
    address: entrypoint, abi: DEPOSIT_ABI, functionName: "deposit",
    args: [usdc, DEPOSIT_ATOMIC, BigInt(prep.precommitment)], gas: 1_000_000n,
  });
  const receipt = await pub.waitForTransactionReceipt({ hash: depHash });
  const evs = parseEventLogs({ abi: DEPOSITED_ABI, logs: receipt.logs });
  const d = evs.map((e) => e.args).find((a) => a._precommitmentHash !== undefined);
  if (!d) throw new Error("Deposited event not found in the receipt — deposit may have reverted.");

  // The note = the secrets we kept + the on-chain (value, label, commitment).
  const note = {
    nullifier: prep.secrets.nullifier,
    secret: prep.secrets.secret,
    value: d._value.toString(),
    label: d._label.toString(),
    commitment: d._commitment.toString(),
  };
  const dir = path.join(process.cwd(), "data");
  fs.mkdirSync(dir, { recursive: true });
  const noteFile = path.join(dir, `mainnet-e2e-deposit-${receipt.blockNumber}.json`);
  fs.writeFileSync(noteFile, JSON.stringify({ network: "base-mainnet", txHash: depHash, ...note }, null, 2), { mode: 0o600 });
  console.log("  deposited. commitment", ("0x" + BigInt(note.commitment).toString(16)).slice(0, 14) + "…", "value", usd(BigInt(note.value)));
  console.log("  [saved] note →", path.basename(noteFile), "(secrets local, never printed)");
  console.log("  tx:", `https://basescan.org/tx/${depHash}`);
  console.log();

  // 3. Pay the seller privately — the exact quickstart path. Persist-first change note,
  //    acceptNotPrivate because the pool is not private yet.
  const buy = zbase.createPrivateFetch({
    deposit: note,
    onNoteRotate: (next) => {
      const f = path.join(dir, `mainnet-e2e-change-${Date.now()}.json`);
      fs.writeFileSync(f, JSON.stringify({ network: "base-mainnet", ...next }, null, 2), { mode: 0o600 });
      console.log("  [saved] change note →", path.basename(f), usd(BigInt(next.value)));
    },
    acceptNotPrivate: true,
    maxAmountAtomic: "10000", // $0.01 ceiling — refuses a hostile 402
  });

  console.log("→ paying the Wayback seller privately…");
  const started = Date.now();
  const res = await buy(SELLER);

  console.log();
  console.log("RESULT:", res.paid ? "PAID + FETCHED" : "FETCHED (was free?)", "in", ((Date.now() - started) / 1000).toFixed(1) + "s");
  console.log("  http status :", res.status);
  console.log("  payer EOA   :", res.payer ?? "(n/a)", "(single-use, unrelated to your deposit)");
  console.log("  amount paid :", res.amount ? usd(BigInt(res.amount)) : "(n/a)");
  console.log("  funding tx  :", res.fundingTxHash ? `https://basescan.org/tx/${res.fundingTxHash}` : "(n/a)");
  const body = typeof res.response === "string" ? res.response : JSON.stringify(res.response ?? null);
  console.log("  seller data :", (body ?? "").slice(0, 300));
  console.log();
  console.log("  PRIVACY:", res.privacy?.private ? "PRIVATE" : "NOT PRIVATE YET (honest disclosure)");
  console.log("    ", res.privacy?.disclosure ?? "(no disclosure)");
  console.log("    set:", res.privacy?.anonymitySet, "of", res.privacy?.minimumForPrivacy);
  console.log();
  console.log(res.paid && res.status < 400
    ? "E2E PASSED: real deposit → private settlement → third-party seller returned goods."
    : "E2E INCOMPLETE: see status/body above. Your note is saved and safe.");
}

main().catch((e) => { console.error("FAILED:", (e as Error).message); process.exitCode = 1; });
