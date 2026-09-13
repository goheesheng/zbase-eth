/**
 * ASP curator — postman tool for the zx402 SVM privacy pool.
 *
 * What it does
 * ------------
 *   1. Reads every `DepositRecord` PDA from the on-chain program for a
 *      given pool, extracting (depositor, label, amount, index).
 *   2. Applies a policy file (allow-list and/or deny-list keyed by
 *      depositor pubkey or label hex) to decide which deposits are
 *      "approved" for the ASP set.
 *   3. Builds a LeanIMT of the approved labels — same hash function as
 *      the on-chain LeanIMT (poseidon2), so the root is comparable.
 *   4. Pins the approved label list to IPFS (optional — falls back to a
 *      local-file CID stub if --no-ipfs is set).
 *   5. Submits `update_asp_root(new_root, ipfs_cid)` to the program if
 *      the root differs from the current on-chain `pool.asp_root`.
 *      Idempotent: a second run with the same state is a no-op.
 *
 * Trust model
 * -----------
 * The postman wields significant power: by withholding a label from the
 * ASP set the postman can prevent a user from withdrawing privately. By
 * including a sanctioned address's label, the postman can make illicit
 * funds withdrawable. Neither move can steal funds from legitimate
 * depositors, but both are governance levers worth being explicit
 * about. This script intentionally produces a verbose audit log so an
 * external observer can reproduce the ASP set from the same inputs.
 *
 * Run
 * ---
 *   from packages/svm/zx402-privacy-pool:
 *
 *   # dry-run: print what would be published, don't write.
 *   npx ts-node scripts/asp-curator.ts \
 *     --pool 7qGhx...PoolPda \
 *     --policy policy.example.json
 *
 *   # publish to chain (requires postman keypair === ANCHOR_WALLET).
 *   npx ts-node scripts/asp-curator.ts \
 *     --pool 7qGhx...PoolPda \
 *     --policy policy.example.json \
 *     --commit
 *
 * Policy file shape (all fields optional):
 *   {
 *     "allowDepositors": ["BWTaGJ...", "..."],   // if present, only these depositors approved
 *     "denyDepositors":  ["7xy...", "..."],       // depositors removed from approved set
 *     "denyLabels":      ["0xabcd...", "..."],    // hex-encoded labels removed
 *     "comment": "free-form note included in the audit log"
 *   }
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  Connection,
  Keypair,
  PublicKey,
  clusterApiUrl,
} from "@solana/web3.js";
import { AnchorProvider, Program, Wallet, BN } from "@coral-xyz/anchor";
import { LeanIMT } from "@zk-kit/lean-imt";
import { poseidon2 } from "poseidon-lite";

// ---- args ----

interface Args {
  pool: string;
  policy?: string;
  commit: boolean;
  noIpfs: boolean;
  rpc?: string;
  walletPath?: string;
  programId: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const out: Args = {
    pool: "",
    commit: false,
    noIpfs: false,
    programId: "7qGhxY9Dc9reSNbNHdX1Rtf7hq7D45zdnV1UY3rpt3eM",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--pool": out.pool = next(); break;
      case "--policy": out.policy = next(); break;
      case "--commit": out.commit = true; break;
      case "--no-ipfs": out.noIpfs = true; break;
      case "--rpc": out.rpc = next(); break;
      case "--wallet": out.walletPath = next(); break;
      case "--program": out.programId = next(); break;
      case "-h": case "--help":
        printHelp(); process.exit(0);
      default:
        console.error(`unknown arg: ${a}`);
        printHelp(); process.exit(2);
    }
  }
  if (!out.pool) {
    console.error("--pool <pubkey> is required");
    printHelp(); process.exit(2);
  }
  return out;
}

function printHelp() {
  console.log(`asp-curator — publish an ASP root for a zx402 SVM pool

REQUIRED
  --pool <pubkey>            pool_state PDA

OPTIONAL
  --policy <path>            JSON policy file (allow/deny lists)
  --commit                   actually submit the on-chain update (default: dry-run)
  --no-ipfs                  skip IPFS pinning, use local-file CID stub
  --rpc <url>                RPC URL (default: devnet)
  --wallet <path>            postman keypair (default: ~/.config/solana/id.json)
  --program <pubkey>         program id (default: 7qGhxY9Dc...)
`);
}

// ---- field-element helpers (mirror @zbase-protocol/core feToBE32) ----

function beToBigInt(bytes: Uint8Array | number[]): bigint {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

function feToBE32(value: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = value;
  if (v < 0n) throw new Error("feToBE32: negative");
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) throw new Error("feToBE32: value > 2^256");
  return out;
}

function bytesToHex(bytes: Uint8Array | number[]): string {
  return "0x" + Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- policy ----

interface Policy {
  allowDepositors?: string[];
  denyDepositors?: string[];
  denyLabels?: string[];
  comment?: string;
}

function loadPolicy(p: string | undefined): Policy {
  if (!p) return {};
  if (!fs.existsSync(p)) {
    throw new Error(`policy file not found: ${p}`);
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

interface ApprovedLeaf {
  index: number;
  depositor: string;
  label: bigint;
  amount: string; // u64 as decimal string
}

function applyPolicy(
  deposits: Array<{
    index: number;
    depositor: PublicKey;
    label: bigint;
    amount: BN;
  }>,
  policy: Policy,
): { approved: ApprovedLeaf[]; rejected: Array<ApprovedLeaf & { reason: string }> } {
  const allow = new Set((policy.allowDepositors ?? []).map((s) => s.trim()));
  const denyDep = new Set((policy.denyDepositors ?? []).map((s) => s.trim()));
  const denyLab = new Set(
    (policy.denyLabels ?? []).map((s) => normalizeHex(s)),
  );
  const approved: ApprovedLeaf[] = [];
  const rejected: Array<ApprovedLeaf & { reason: string }> = [];

  for (const d of deposits) {
    const labelHex = normalizeHex(bytesToHex(feToBE32(d.label)));
    const depositor = d.depositor.toBase58();
    const leaf: ApprovedLeaf = {
      index: d.index,
      depositor,
      label: d.label,
      amount: d.amount.toString(),
    };
    if (allow.size > 0 && !allow.has(depositor)) {
      rejected.push({ ...leaf, reason: "not in allowDepositors" });
      continue;
    }
    if (denyDep.has(depositor)) {
      rejected.push({ ...leaf, reason: "depositor on denyDepositors" });
      continue;
    }
    if (denyLab.has(labelHex)) {
      rejected.push({ ...leaf, reason: "label on denyLabels" });
      continue;
    }
    approved.push(leaf);
  }
  return { approved, rejected };
}

function normalizeHex(s: string): string {
  const t = s.trim().toLowerCase();
  return t.startsWith("0x") ? t : "0x" + t;
}

// ---- IPFS (optional) ----

async function pinToIpfs(payload: object, noIpfs: boolean): Promise<string> {
  const json = JSON.stringify(payload, null, 2);
  if (noIpfs) {
    // Local-file stub: write to ./asp-snapshots/<sha256>.json and return a
    // pseudo-CID derived from the content hash. Lets the postman publish
    // an honest digest without an IPFS dependency.
    const dir = path.join(process.cwd(), "asp-snapshots");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const crypto = await import("node:crypto");
    const digest = crypto.createHash("sha256").update(json).digest("hex");
    const fname = path.join(dir, `${digest}.json`);
    fs.writeFileSync(fname, json);
    return `local:sha256:${digest}`;
  }

  // Best-effort IPFS via a public pinning gateway. We use Pinata's public
  // upload; if PINATA_JWT is not set we surface a clear error so the
  // postman can either configure Pinata or use --no-ipfs.
  const jwt = process.env.PINATA_JWT;
  if (!jwt) {
    throw new Error(
      "IPFS pinning requires PINATA_JWT in env, or pass --no-ipfs to use a local content-addressed stub.",
    );
  }
  const fd = new FormData();
  fd.append(
    "file",
    new Blob([json], { type: "application/json" }),
    "asp-snapshot.json",
  );
  const res = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}` },
    body: fd,
  });
  if (!res.ok) {
    throw new Error(`pinata upload failed: ${res.status} ${await res.text()}`);
  }
  const { IpfsHash } = (await res.json()) as { IpfsHash: string };
  return `ipfs://${IpfsHash}`;
}

// ---- main ----

async function main() {
  const args = parseArgs();
  const walletPath = args.walletPath ?? path.join(os.homedir(), ".config/solana/id.json");
  const wallet = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf8"))),
  );

  const rpcUrl = args.rpc ?? process.env.ANCHOR_PROVIDER_URL ?? clusterApiUrl("devnet");
  const connection = new Connection(rpcUrl, "confirmed");
  const provider = new AnchorProvider(connection, new Wallet(wallet), {
    commitment: "confirmed",
  });

  // IDL discovery: prefer freshly-built target IDL; fall back to the SDK's bundled copy.
  const idlCandidates = [
    path.join(__dirname, "..", "target", "idl", "zx402_privacy_pool.json"),
    path.join(__dirname, "..", "..", "sdk", "src", "idl.json"),
  ];
  const idlPath = idlCandidates.find((p) => fs.existsSync(p));
  if (!idlPath) {
    throw new Error(`IDL not found in any of:\n  ${idlCandidates.join("\n  ")}`);
  }
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const program: any = new Program(idl, provider);

  const programId = new PublicKey(args.programId);
  const poolPda = new PublicKey(args.pool);
  const policy = loadPolicy(args.policy);

  console.log(`asp-curator`);
  console.log(`  program:  ${programId.toBase58()}`);
  console.log(`  pool:     ${poolPda.toBase58()}`);
  console.log(`  rpc:      ${rpcUrl}`);
  console.log(`  wallet:   ${wallet.publicKey.toBase58()}`);
  console.log(`  policy:   ${args.policy ?? "(none — approve all)"}`);
  console.log(`  mode:     ${args.commit ? "COMMIT" : "DRY-RUN"}`);
  console.log();

  // 1. Confirm pool exists and we are the postman.
  const pool = await program.account.poolState.fetch(poolPda);
  const postman = (pool.postman as PublicKey).toBase58();
  if (postman !== wallet.publicKey.toBase58()) {
    console.warn(
      `WARN: this wallet (${wallet.publicKey.toBase58()}) is NOT the registered postman (${postman}). update_asp_root will revert.`,
    );
  }

  // 2. Fetch all DepositRecord accounts for this pool.
  const all = await program.account.depositRecord.all([
    { memcmp: { offset: 8, bytes: poolPda.toBase58() } },
  ]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sorted = [...all].sort((a: any, b: any) =>
    a.account.index.toNumber() - b.account.index.toNumber(),
  );
  const deposits = sorted.map((d) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const acc: any = d.account;
    return {
      index: acc.index.toNumber() as number,
      depositor: acc.depositor as PublicKey,
      label: beToBigInt(acc.label as number[]),
      amount: acc.amount as BN,
    };
  });
  console.log(`Found ${deposits.length} DepositRecord(s) for this pool.`);

  // 3. Apply policy.
  const { approved, rejected } = applyPolicy(deposits, policy);
  console.log(`  approved: ${approved.length}`);
  console.log(`  rejected: ${rejected.length}`);
  if (rejected.length) {
    for (const r of rejected) {
      console.log(`    ✗ idx=${r.index} ${r.depositor.slice(0, 8)}… (${r.reason})`);
    }
  }

  if (approved.length === 0) {
    console.log(
      "\nNo approved labels. Publishing an empty ASP set is allowed but means no withdrawals can succeed.",
    );
  }

  // 4. Build the ASP LeanIMT (poseidon2 — same as on-chain).
  const aspTree = new LeanIMT<bigint>((a, b) => poseidon2([a, b]));
  for (const a of approved) aspTree.insert(a.label);
  const newRoot = approved.length > 0 ? aspTree.root : 0n;
  const newRootBE = feToBE32(newRoot);
  const oldRoot = beToBigInt(pool.asp_root as number[]);
  console.log(`  new ASP root: ${bytesToHex(newRootBE).slice(0, 18)}…`);
  console.log(`  old ASP root: ${bytesToHex(feToBE32(oldRoot)).slice(0, 18)}…`);

  if (newRoot === oldRoot) {
    console.log("\nASP root unchanged. Nothing to commit.");
    return;
  }

  // 5. Build snapshot payload (audit log).
  const snapshot = {
    schema: "zx402-asp-snapshot/v1",
    program: programId.toBase58(),
    pool: poolPda.toBase58(),
    generatedAt: new Date().toISOString(),
    postman: wallet.publicKey.toBase58(),
    policy,
    approved: approved.map((a) => ({
      ...a,
      label: bytesToHex(feToBE32(a.label)),
    })),
    rejected: rejected.map((r) => ({
      ...r,
      label: bytesToHex(feToBE32(r.label)),
    })),
    aspRoot: bytesToHex(newRootBE),
    aspDepth: aspTree.depth,
  };

  // 6. Pin / hash snapshot.
  const cid = approved.length > 0
    ? await pinToIpfs(snapshot, args.noIpfs)
    : "empty";
  console.log(`  snapshot CID: ${cid}`);

  if (!args.commit) {
    console.log("\nDry-run complete. Pass --commit to publish on-chain.");
    return;
  }

  // 7. Submit update_asp_root.
  const sig = await program.methods
    .updateAspRoot(Array.from(newRootBE), cid)
    .accounts({
      poolState: poolPda,
      postman: wallet.publicKey,
    })
    .rpc();
  console.log(`\nupdate_asp_root tx: ${sig}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
